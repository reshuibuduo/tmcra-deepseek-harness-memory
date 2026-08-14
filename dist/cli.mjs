#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { Document, isMap, parseDocument } from "yaml";
//#region src/device-auth.ts
const DEFAULT_AUTH_BASE_URL = "https://tmcra.com";
const CLIENT_ID = "tmcra-deepseek-harness";
const REQUEST_TIMEOUT_MS = 3e4;
const CREDENTIAL_KEYS = {
	apiKey: "TMCRA_API_KEY",
	apiBaseUrl: "TMCRA_API_BASE_URL",
	globalScope: "TMCRA_GLOBAL_SCOPE",
	projectScopePrefix: "TMCRA_PROJECT_SCOPE_PREFIX"
};
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/u;
function resolveDshHome(value) {
	return resolve(value?.trim() || process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
}
function credentialsPath(dshHome) {
	return join(resolveDshHome(dshHome), ".credentials.yaml");
}
function pendingDeliveryPath(dshHome) {
	return join(resolveDshHome(dshHome), "tmcra", "deepseek-harness-device-auth.json");
}
function assertWebUrl(value, label) {
	const url = new URL(value);
	const local = [
		"localhost",
		"127.0.0.1",
		"::1"
	].includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${label} must use HTTPS (or localhost for development)`);
	if (url.username || url.password) throw new Error(`${label} must not contain embedded credentials`);
	return url.toString().replace(/\/$/u, "");
}
function pkcePair() {
	const verifier = randomBytes(48).toString("base64url");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url")
	};
}
function defaultSleep(milliseconds) {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
async function postJson(fetchImpl, url, body) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "tmcra-deepseek-harness-memory/0.1.1"
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
		const text = await response.text();
		let payload = {};
		if (text) try {
			payload = JSON.parse(text);
		} catch {
			throw new Error(`TMCRA authorization returned non-JSON HTTP ${response.status}`);
		}
		return {
			response,
			payload
		};
	} finally {
		clearTimeout(timeout);
	}
}
function errorCode(payload) {
	if (typeof payload.error === "string") return payload.error;
	if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
		const code = payload.error.code;
		return typeof code === "string" ? code : null;
	}
	return typeof payload.code === "string" ? payload.code : null;
}
function safeAuthorizationError(response, payload) {
	const code = String(errorCode(payload) || "authorization_failed").replace(/[^A-Za-z0-9_.-]/gu, "_");
	return /* @__PURE__ */ new Error(`TMCRA device authorization failed (${code}, HTTP ${response.status}).`);
}
function transientNetworkError(error) {
	if (!error || typeof error !== "object") return false;
	const candidate = error;
	if (candidate.name === "AbortError") return true;
	const code = String(candidate.code || candidate.cause?.code || "");
	if ([
		"ECONNABORTED",
		"ECONNREFUSED",
		"ECONNRESET",
		"EHOSTUNREACH",
		"ENETDOWN",
		"ENETUNREACH",
		"ENOTFOUND",
		"EPIPE",
		"ETIMEDOUT",
		"EAI_AGAIN",
		"UND_ERR_CONNECT_TIMEOUT",
		"UND_ERR_HEADERS_TIMEOUT",
		"UND_ERR_SOCKET"
	].includes(code)) return true;
	return candidate.name === "TypeError" && /fetch failed/iu.test(String(candidate.message || ""));
}
function openBrowser(url) {
	let command;
	let args;
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
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true
		});
		child.on("error", () => void 0);
		child.unref();
		return true;
	} catch {
		return false;
	}
}
async function assertOwnerOnly(path) {
	if (process.platform === "win32" || !existsSync(path)) return;
	if (((await stat(path)).mode & 63) !== 0) throw new Error(`TMCRA refuses to update ${path} until its permissions are limited to the owner (chmod 600).`);
}
function credentialsDocument(text) {
	const document = text.trim() ? parseDocument(text, {
		prettyErrors: false,
		uniqueKeys: true
	}) : new Document({});
	if (document.errors.length) throw new Error("Harness credentials YAML is invalid; no credential was changed.");
	if (document.contents !== null && !isMap(document.contents)) throw new Error("Harness credentials YAML must contain one key-value mapping.");
	const value = document.toJS();
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Harness credentials YAML must contain one key-value mapping.");
	for (const [key, credential] of Object.entries(value)) if (!CREDENTIAL_REF.test(key) || typeof credential !== "string" || credential.length === 0) throw new Error("Harness credentials YAML contains an invalid entry; no credential was changed.");
	return document;
}
async function updateHarnessCredentials(updates, dshHome) {
	const path = credentialsPath(dshHome);
	await mkdir(dirname(path), { recursive: true });
	await assertOwnerOnly(path);
	await withFileLock(path, async () => {
		const document = credentialsDocument(existsSync(path) ? await readFile(path, "utf8") : "");
		for (const [key, value] of Object.entries(updates)) {
			if (!CREDENTIAL_REF.test(key)) throw new Error(`Invalid Harness credential reference: ${key}`);
			if (value === null) document.delete(key);
			else if (!value) throw new Error(`Harness credential ${key} cannot be empty.`);
			else document.set(key, value);
		}
		await writeFileAtomic(path, document.toString({ lineWidth: 0 }), {
			mode: 384,
			dirMode: 448
		});
	});
	if (process.platform !== "win32") await chmod(path, 384);
	return path;
}
async function readHarnessCredentialStatus(dshHome) {
	const path = credentialsPath(dshHome);
	if (!existsSync(path)) return {
		configured: false,
		credentialsPath: path
	};
	await assertOwnerOnly(path);
	const value = credentialsDocument(await readFile(path, "utf8")).toJS();
	return {
		configured: Object.values(CREDENTIAL_KEYS).every((key) => Boolean(value[key])),
		credentialsPath: path,
		apiBaseUrl: value[CREDENTIAL_KEYS.apiBaseUrl] || null,
		globalScope: value[CREDENTIAL_KEYS.globalScope] || null,
		projectScopePrefix: value[CREDENTIAL_KEYS.projectScopePrefix] || null
	};
}
async function atomicPending(path, value) {
	await mkdir(dirname(path), { recursive: true });
	await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 384,
		dirMode: 448
	});
	if (process.platform !== "win32") await chmod(path, 384);
}
async function acknowledgeDelivery(fetchImpl, baseUrl, pending, sleep) {
	let lastError;
	for (let attempt = 0; attempt < 6; attempt += 1) {
		if (attempt) await sleep(Math.min(8e3, 500 * 2 ** (attempt - 1)));
		try {
			const result = await postJson(fetchImpl, `${baseUrl}/api/device/v1/token`, {
				deviceCode: pending.deviceCode,
				codeVerifier: pending.codeVerifier,
				deliveryReceipt: pending.deliveryReceipt
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
async function persistAndAcknowledge(pending, options) {
	const path = await updateHarnessCredentials({
		[CREDENTIAL_KEYS.apiKey]: pending.accessToken,
		[CREDENTIAL_KEYS.apiBaseUrl]: pending.apiBaseUrl,
		[CREDENTIAL_KEYS.globalScope]: `${pending.scopeNamespace}-global`,
		[CREDENTIAL_KEYS.projectScopePrefix]: `${pending.scopeNamespace}-project`
	}, options.dshHome);
	const pendingPath = pendingDeliveryPath(options.dshHome);
	await atomicPending(pendingPath, pending);
	await acknowledgeDelivery(options.fetchImpl, pending.authorizationBaseUrl, pending, options.sleep);
	await rm(pendingPath, { force: true });
	return path;
}
async function recoverPending(options) {
	const path = pendingDeliveryPath(options.dshHome);
	if (!existsSync(path)) return null;
	await assertOwnerOnly(path);
	let pending;
	try {
		pending = JSON.parse(await readFile(path, "utf8"));
	} catch {
		await rm(path, { force: true });
		return null;
	}
	if (pending.schemaVersion !== 1 || pending.authorizationBaseUrl !== options.authBaseUrl || Date.parse(pending.expiresAt) <= Date.now()) {
		await rm(path, { force: true });
		return null;
	}
	return {
		credentialsPath: await persistAndAcknowledge(pending, options),
		recovered: true
	};
}
async function authorizeDeepSeekHarness(options = {}) {
	const fetchImpl = options.fetchImpl ?? fetch;
	const sleep = options.sleep ?? defaultSleep;
	const dshHome = resolveDshHome(options.dshHome);
	const authBaseUrl = assertWebUrl(options.authBaseUrl ?? DEFAULT_AUTH_BASE_URL, "TMCRA authorization URL");
	const authUrl = new URL(authBaseUrl);
	if (authUrl.search || authUrl.hash) throw new Error("TMCRA authorization URL must not contain a query or fragment.");
	const recovered = await recoverPending({
		fetchImpl,
		sleep,
		dshHome,
		authBaseUrl
	});
	if (recovered) {
		options.onProgress?.({
			type: "completed",
			credentialsPath: recovered.credentialsPath
		});
		return {
			...recovered,
			browserOpened: false
		};
	}
	const { verifier, challenge } = pkcePair();
	const started = await postJson(fetchImpl, `${authBaseUrl}/api/device/v1/authorizations`, {
		clientId: CLIENT_ID,
		clientName: `DeepSeek Harness (${platform()} ${process.arch})`,
		clientVersion: "0.1.1",
		codeChallenge: challenge,
		codeChallengeMethod: "S256"
	});
	if (!started.response.ok) throw safeAuthorizationError(started.response, started.payload);
	const deviceCode = String(started.payload.deviceCode || "");
	const userCode = String(started.payload.userCode || "");
	const verificationUrl = assertWebUrl(String(started.payload.verificationUriComplete || started.payload.verificationUri || ""), "TMCRA verification URL");
	const expiresIn = Number(started.payload.expiresIn);
	let interval = Number(started.payload.interval || 5);
	if (started.payload.provider !== "deepseek_harness" || !/^[A-Za-z0-9_-]{43}$/u.test(deviceCode) || !/^[A-HJ-NP-Z2-9]{8}$/u.test(userCode) || new URL(verificationUrl).origin !== authUrl.origin || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 1800 || !Number.isFinite(interval) || interval <= 0 || interval > 60) throw new Error("TMCRA authorization response is incomplete.");
	const expiresAt = new Date(Date.now() + expiresIn * 1e3).toISOString();
	options.onProgress?.({
		type: "authorization",
		userCode,
		verificationUrl,
		expiresAt
	});
	const browserOpened = options.noOpen ? false : openBrowser(verificationUrl);
	options.onProgress?.({ type: "waiting" });
	let tokenPayload = null;
	let networkFailures = 0;
	while (Date.now() < Date.parse(expiresAt)) {
		await sleep(Math.max(50, interval * 1e3));
		let token;
		try {
			token = await postJson(fetchImpl, `${authBaseUrl}/api/device/v1/token`, {
				deviceCode,
				codeVerifier: verifier
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
	if (!/^tmcra_st_[A-Za-z0-9_-]{1,160}\.[A-Za-z0-9_-]{20,700}$/u.test(accessToken) || !/^[A-Za-z0-9_-]{43}$/u.test(deliveryReceipt) || tokenPayload.deliveryAcknowledgementRequired !== true || String(tokenPayload.tokenType || "").toLowerCase() !== "bearer" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/u.test(scopeNamespace) || !Number.isFinite(tokenExpiresIn) || tokenExpiresIn <= 0 || tokenExpiresIn > 3456e4) throw new Error("TMCRA token response is incomplete.");
	const credentialsFile = await persistAndAcknowledge({
		schemaVersion: 1,
		authorizationBaseUrl: authBaseUrl,
		deviceCode,
		codeVerifier: verifier,
		deliveryReceipt,
		accessToken,
		apiBaseUrl,
		scopeNamespace,
		expiresAt: new Date(Date.now() + tokenExpiresIn * 1e3).toISOString()
	}, {
		fetchImpl,
		sleep,
		dshHome
	});
	options.onProgress?.({
		type: "completed",
		credentialsPath: credentialsFile
	});
	return {
		credentialsPath: credentialsFile,
		recovered: false,
		browserOpened,
		apiBaseUrl,
		globalScope: `${scopeNamespace}-global`,
		projectScopePrefix: `${scopeNamespace}-project`
	};
}
async function logoutDeepSeekHarness(dshHome) {
	const path = await updateHarnessCredentials({
		[CREDENTIAL_KEYS.apiKey]: null,
		[CREDENTIAL_KEYS.apiBaseUrl]: null,
		[CREDENTIAL_KEYS.globalScope]: null,
		[CREDENTIAL_KEYS.projectScopePrefix]: null
	}, dshHome);
	await rm(pendingDeliveryPath(dshHome), { force: true });
	return path;
}
//#endregion
//#region src/cli.ts
function option(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : void 0;
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function main() {
	const command = process.argv[2] || "help";
	const json = process.argv.includes("--json");
	const dshHome = option("--dsh-home");
	if (command === "login") {
		const result = await authorizeDeepSeekHarness({
			dshHome,
			authBaseUrl: option("--auth-base-url"),
			noOpen: process.argv.includes("--no-open"),
			onProgress: (event) => {
				if (json) return;
				if (event.type === "authorization") {
					process.stderr.write(`TMCRA authorization code: ${event.userCode}\n`);
					process.stderr.write(`Open: ${event.verificationUrl}\n`);
				} else if (event.type === "waiting") process.stderr.write("Waiting for approval in your TMCRA account...\n");
				else if (event.type === "network_retry") process.stderr.write("TMCRA authorization network retry in progress...\n");
			}
		});
		if (json) printJson({
			ok: true,
			...result
		});
		else process.stdout.write(`TMCRA is connected. Harness credentials were saved to ${result.credentialsPath}.\n`);
		return;
	}
	if (command === "status") {
		const status = await readHarnessCredentialStatus(dshHome);
		if (json) printJson({
			ok: true,
			...status
		});
		else process.stdout.write(status.configured ? `TMCRA is configured in ${status.credentialsPath}.\n` : `TMCRA is not configured. Run: tmcra-harness-memory login\n`);
		return;
	}
	if (command === "logout") {
		const path = await logoutDeepSeekHarness(dshHome);
		if (json) printJson({
			ok: true,
			configured: false,
			credentialsPath: path
		});
		else process.stdout.write(`TMCRA credentials were removed from ${path}. Revoke the connection in your TMCRA account if this device is no longer trusted.\n`);
		return;
	}
	process.stdout.write(`Usage:\n  tmcra-harness-memory login [--no-open] [--auth-base-url URL] [--dsh-home PATH] [--json]\n  tmcra-harness-memory status [--dsh-home PATH] [--json]\n  tmcra-harness-memory logout [--dsh-home PATH] [--json]\n`);
}
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) await main().catch((error) => {
	const message = error instanceof Error ? error.message : "TMCRA login failed.";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
//#endregion
export { main };
