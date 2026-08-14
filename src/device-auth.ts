import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { Document, isMap, parseDocument } from "yaml";

const DEFAULT_AUTH_BASE_URL = "https://tmcra.com";
const CLIENT_ID = "tmcra-deepseek-harness";
const REQUEST_TIMEOUT_MS = 30_000;
const CREDENTIAL_KEYS = {
  apiKey: "TMCRA_API_KEY",
  apiBaseUrl: "TMCRA_API_BASE_URL",
  globalScope: "TMCRA_GLOBAL_SCOPE",
  projectScopePrefix: "TMCRA_PROJECT_SCOPE_PREFIX",
} as const;
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u;

type FetchLike = typeof fetch;
type ProgressEvent =
  | { type: "authorization"; userCode: string; verificationUrl: string; expiresAt: string }
  | { type: "waiting" }
  | { type: "network_retry" }
  | { type: "completed"; credentialsPath: string };

export type DeviceAuthOptions = {
  authBaseUrl?: string;
  dshHome?: string;
  noOpen?: boolean;
  fetchImpl?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  onProgress?: (event: ProgressEvent) => void;
};

type PendingDelivery = {
  schemaVersion: 1;
  authorizationBaseUrl: string;
  deviceCode: string;
  codeVerifier: string;
  deliveryReceipt: string;
  accessToken: string;
  apiBaseUrl: string;
  scopeNamespace: string;
  expiresAt: string;
};

export function resolveDshHome(value?: string) {
  return resolve(value?.trim() || process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
}

export function credentialsPath(dshHome?: string) {
  return join(resolveDshHome(dshHome), ".credentials.yaml");
}

function pendingDeliveryPath(dshHome?: string) {
  return join(resolveDshHome(dshHome), "tmcra", "deepseek-harness-device-auth.json");
}

function assertWebUrl(value: string, label: string) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error(`${label} must use HTTPS (or localhost for development)`);
  }
  if (url.username || url.password) throw new Error(`${label} must not contain embedded credentials`);
  return url.toString().replace(/\/$/u, "");
}

function pkcePair() {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function postJson(fetchImpl: FetchLike, url: string, body: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "dsh-tmcra-memory/0.1.1",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    if (text) {
      try {
        payload = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error(`TMCRA authorization returned non-JSON HTTP ${response.status}`);
      }
    }
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function errorCode(payload: Record<string, unknown>) {
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
    const code = (payload.error as Record<string, unknown>).code;
    return typeof code === "string" ? code : null;
  }
  return typeof payload.code === "string" ? payload.code : null;
}

function safeAuthorizationError(response: Response, payload: Record<string, unknown>) {
  const code = String(errorCode(payload) || "authorization_failed").replace(/[^A-Za-z0-9_.-]/gu, "_");
  return new Error(`TMCRA device authorization failed (${code}, HTTP ${response.status}).`);
}

function transientNetworkError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  if (candidate.name === "AbortError") return true;
  const code = String(candidate.code || candidate.cause?.code || "");
  if ([
    "ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETDOWN",
    "ENETUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
  ].includes(code)) return true;
  return candidate.name === "TypeError" && /fetch failed/iu.test(String(candidate.message || ""));
}

function openBrowser(url: string) {
  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function assertOwnerOnly(path: string) {
  if (process.platform === "win32" || !existsSync(path)) return;
  const mode = (await stat(path)).mode;
  if ((mode & 0o077) !== 0) {
    throw new Error(`TMCRA refuses to update ${path} until its permissions are limited to the owner (chmod 600).`);
  }
}

function credentialsDocument(text: string) {
  const document = text.trim()
    ? parseDocument(text, { prettyErrors: false, uniqueKeys: true })
    : new Document({});
  if (document.errors.length) throw new Error("Harness credentials YAML is invalid; no credential was changed.");
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error("Harness credentials YAML must contain one key-value mapping.");
  }
  const value = document.toJS() as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Harness credentials YAML must contain one key-value mapping.");
  }
  for (const [key, credential] of Object.entries(value as Record<string, unknown>)) {
    if (!CREDENTIAL_REF.test(key) || typeof credential !== "string" || credential.length === 0) {
      throw new Error("Harness credentials YAML contains an invalid entry; no credential was changed.");
    }
  }
  return document;
}

export async function updateHarnessCredentials(
  updates: Readonly<Record<string, string | null>>,
  dshHome?: string,
) {
  const path = credentialsPath(dshHome);
  await mkdir(dirname(path), { recursive: true });
  await assertOwnerOnly(path);
  await withFileLock(path, async () => {
    const current = existsSync(path) ? await readFile(path, "utf8") : "";
    const document = credentialsDocument(current);
    for (const [key, value] of Object.entries(updates)) {
      if (!CREDENTIAL_REF.test(key)) throw new Error(`Invalid Harness credential reference: ${key}`);
      if (value === null) document.delete(key);
      else if (!value) throw new Error(`Harness credential ${key} cannot be empty.`);
      else document.set(key, value);
    }
    await writeFileAtomic(path, document.toString({ lineWidth: 0 }), {
      mode: 0o600,
      dirMode: 0o700,
    });
  });
  if (process.platform !== "win32") await chmod(path, 0o600);
  return path;
}

export async function readHarnessCredentialStatus(dshHome?: string) {
  const path = credentialsPath(dshHome);
  if (!existsSync(path)) return { configured: false, credentialsPath: path };
  await assertOwnerOnly(path);
  const document = credentialsDocument(await readFile(path, "utf8"));
  const value = document.toJS() as Record<string, string>;
  return {
    configured: Object.values(CREDENTIAL_KEYS).every((key) => Boolean(value[key])),
    credentialsPath: path,
    apiBaseUrl: value[CREDENTIAL_KEYS.apiBaseUrl] || null,
    globalScope: value[CREDENTIAL_KEYS.globalScope] || null,
    projectScopePrefix: value[CREDENTIAL_KEYS.projectScopePrefix] || null,
  };
}

async function atomicPending(path: string, value: PendingDelivery) {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function acknowledgeDelivery(
  fetchImpl: FetchLike,
  baseUrl: string,
  pending: PendingDelivery,
  sleep: (milliseconds: number) => Promise<void>,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt) await sleep(Math.min(8_000, 500 * 2 ** (attempt - 1)));
    try {
      const result = await postJson(fetchImpl, `${baseUrl}/api/device/v1/token`, {
        deviceCode: pending.deviceCode,
        codeVerifier: pending.codeVerifier,
        deliveryReceipt: pending.deliveryReceipt,
      });
      if (result.response.ok && result.payload.claimed === true) return;
      lastError = safeAuthorizationError(result.response, result.payload);
      if (result.response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("TMCRA saved the provisional credential but could not confirm delivery. Run login again to recover it.", { cause: lastError });
}

async function persistAndAcknowledge(
  pending: PendingDelivery,
  options: Required<Pick<DeviceAuthOptions, "fetchImpl" | "sleep">> & { dshHome: string },
) {
  const path = await updateHarnessCredentials({
    [CREDENTIAL_KEYS.apiKey]: pending.accessToken,
    [CREDENTIAL_KEYS.apiBaseUrl]: pending.apiBaseUrl,
    [CREDENTIAL_KEYS.globalScope]: `${pending.scopeNamespace}-global`,
    [CREDENTIAL_KEYS.projectScopePrefix]: `${pending.scopeNamespace}-project`,
  }, options.dshHome);
  const pendingPath = pendingDeliveryPath(options.dshHome);
  await atomicPending(pendingPath, pending);
  await acknowledgeDelivery(options.fetchImpl, pending.authorizationBaseUrl, pending, options.sleep);
  await rm(pendingPath, { force: true });
  return path;
}

async function recoverPending(options: Required<Pick<DeviceAuthOptions, "fetchImpl" | "sleep">> & { dshHome: string; authBaseUrl: string }) {
  const path = pendingDeliveryPath(options.dshHome);
  if (!existsSync(path)) return null;
  await assertOwnerOnly(path);
  let pending: PendingDelivery;
  try {
    pending = JSON.parse(await readFile(path, "utf8")) as PendingDelivery;
  } catch {
    await rm(path, { force: true });
    return null;
  }
  if (
    pending.schemaVersion !== 1 ||
    pending.authorizationBaseUrl !== options.authBaseUrl ||
    Date.parse(pending.expiresAt) <= Date.now()
  ) {
    await rm(path, { force: true });
    return null;
  }
  const credentialsFile = await persistAndAcknowledge(pending, options);
  return { credentialsPath: credentialsFile, recovered: true };
}

export async function authorizeDeepSeekHarness(options: DeviceAuthOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const dshHome = resolveDshHome(options.dshHome);
  const authBaseUrl = assertWebUrl(options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL, "TMCRA authorization URL");
  const authUrl = new URL(authBaseUrl);
  if (authUrl.search || authUrl.hash) throw new Error("TMCRA authorization URL must not contain a query or fragment.");

  const recovered = await recoverPending({ fetchImpl, sleep, dshHome, authBaseUrl });
  if (recovered) {
    options.onProgress?.({ type: "completed", credentialsPath: recovered.credentialsPath });
    return { ...recovered, browserOpened: false };
  }

  const { verifier, challenge } = pkcePair();
  const started = await postJson(fetchImpl, `${authBaseUrl}/api/device/v1/authorizations`, {
    clientId: CLIENT_ID,
    clientName: `DeepSeek Harness (${platform()} ${process.arch})`,
    clientVersion: "0.1.1",
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });
  if (!started.response.ok) throw safeAuthorizationError(started.response, started.payload);

  const deviceCode = String(started.payload.deviceCode || "");
  const userCode = String(started.payload.userCode || "");
  const verificationUrl = assertWebUrl(
    String(started.payload.verificationUriComplete || started.payload.verificationUri || ""),
    "TMCRA verification URL",
  );
  const expiresIn = Number(started.payload.expiresIn);
  let interval = Number(started.payload.interval || 5);
  if (
    started.payload.provider !== "deepseek_harness" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(deviceCode) ||
    !/^[A-HJ-NP-Z2-9]{8}$/u.test(userCode) ||
    new URL(verificationUrl).origin !== authUrl.origin ||
    !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 1_800 ||
    !Number.isFinite(interval) || interval <= 0 || interval > 60
  ) throw new Error("TMCRA authorization response is incomplete.");

  const expiresAt = new Date(Date.now() + expiresIn * 1_000).toISOString();
  options.onProgress?.({ type: "authorization", userCode, verificationUrl, expiresAt });
  const browserOpened = options.noOpen ? false : openBrowser(verificationUrl);
  options.onProgress?.({ type: "waiting" });

  let tokenPayload: Record<string, unknown> | null = null;
  let networkFailures = 0;
  while (Date.now() < Date.parse(expiresAt)) {
    await sleep(Math.max(50, interval * 1_000));
    let token;
    try {
      token = await postJson(fetchImpl, `${authBaseUrl}/api/device/v1/token`, {
        deviceCode,
        codeVerifier: verifier,
      });
      networkFailures = 0;
    } catch (error) {
      if (!transientNetworkError(error)) throw error;
      networkFailures += 1;
      interval = Math.min(15, Math.max(interval, 2 ** Math.min(networkFailures, 4)));
      options.onProgress?.({ type: "network_retry" });
      continue;
    }
    if (token.response.ok) {
      tokenPayload = token.payload;
      break;
    }
    const code = errorCode(token.payload);
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval = Math.min(60, interval + 5);
      continue;
    }
    if (code === "access_denied") throw new Error("TMCRA authorization was denied in the browser.");
    if (code === "expired_token") throw new Error("TMCRA authorization expired. Run login again.");
    throw safeAuthorizationError(token.response, token.payload);
  }
  if (!tokenPayload) throw new Error("TMCRA authorization expired. Run login again.");

  const accessToken = String(tokenPayload.accessToken || "");
  const deliveryReceipt = String(tokenPayload.deliveryReceipt || "");
  const apiBaseUrl = assertWebUrl(String(tokenPayload.baseUrl || ""), "TMCRA API base URL");
  const scopeNamespace = String(tokenPayload.scopeNamespace || "").trim();
  const tokenExpiresIn = Number(tokenPayload.expiresIn);
  if (
    !/^tmcra_st_[A-Za-z0-9_-]{1,160}\.[A-Za-z0-9_-]{20,700}$/u.test(accessToken) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(deliveryReceipt) ||
    tokenPayload.deliveryAcknowledgementRequired !== true ||
    String(tokenPayload.tokenType || "").toLowerCase() !== "bearer" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/u.test(scopeNamespace) ||
    !Number.isFinite(tokenExpiresIn) || tokenExpiresIn <= 0 || tokenExpiresIn > 400 * 24 * 60 * 60
  ) throw new Error("TMCRA token response is incomplete.");

  const credentialsFile = await persistAndAcknowledge({
    schemaVersion: 1,
    authorizationBaseUrl: authBaseUrl,
    deviceCode,
    codeVerifier: verifier,
    deliveryReceipt,
    accessToken,
    apiBaseUrl,
    scopeNamespace,
    expiresAt: new Date(Date.now() + tokenExpiresIn * 1_000).toISOString(),
  }, { fetchImpl, sleep, dshHome });
  options.onProgress?.({ type: "completed", credentialsPath: credentialsFile });
  return {
    credentialsPath: credentialsFile,
    recovered: false,
    browserOpened,
    apiBaseUrl,
    globalScope: `${scopeNamespace}-global`,
    projectScopePrefix: `${scopeNamespace}-project`,
  };
}

export async function logoutDeepSeekHarness(dshHome?: string) {
  const path = await updateHarnessCredentials({
    [CREDENTIAL_KEYS.apiKey]: null,
    [CREDENTIAL_KEYS.apiBaseUrl]: null,
    [CREDENTIAL_KEYS.globalScope]: null,
    [CREDENTIAL_KEYS.projectScopePrefix]: null,
  }, dshHome);
  await rm(pendingDeliveryPath(dshHome), { force: true });
  return path;
}
