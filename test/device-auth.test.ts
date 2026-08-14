import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  authorizeDeepSeekHarness,
  credentialsPath,
  logoutDeepSeekHarness,
  readHarnessCredentialStatus,
  updateHarnessCredentials,
} from "../src/device-auth.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryHome() {
  const path = await mkdtemp(join(tmpdir(), "tmcra-harness-auth-"));
  homes.push(path);
  return path;
}

function deviceServer(options: { failAcknowledgement?: boolean; provider?: string } = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let pollCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith("/api/device/v1/authorizations")) {
      return Response.json({
        ok: true,
        provider: options.provider ?? "deepseek_harness",
        deviceCode: "d".repeat(43),
        userCode: "ABCD2345",
        verificationUri: "http://127.0.0.1:4173/console/connect/deepseek-harness",
        verificationUriComplete: "http://127.0.0.1:4173/console/connect/deepseek-harness?user_code=ABCD2345",
        expiresIn: 600,
        interval: 0.05,
      }, { status: 201 });
    }
    if (url.endsWith("/api/device/v1/token") && body.deliveryReceipt) {
      return options.failAcknowledgement
        ? Response.json({ ok: false, error: { code: "temporary_failure" } }, { status: 503 })
        : Response.json({ ok: true, claimed: true, expiresIn: 31_536_000 });
    }
    pollCount += 1;
    if (pollCount === 1) {
      return Response.json({ ok: false, error: { code: "authorization_pending" }, interval: 0.05 }, { status: 400 });
    }
    return Response.json({
      ok: true,
      accessToken: `tmcra_st_harness_test.${"s".repeat(32)}`,
      deliveryReceipt: "r".repeat(43),
      tokenType: "Bearer",
      expiresIn: 600,
      baseUrl: "https://api.tmcra.com",
      scopeNamespace: "personal-harness-test",
      deliveryAcknowledgementRequired: true,
    });
  };
  return { fetchImpl, requests };
}

describe("DeepSeek Harness device authorization", () => {
  it("stores a scoped TMCRA credential set in the Harness managed store", async () => {
    const home = await temporaryHome();
    await updateHarnessCredentials({ DEEPSEEK_API_KEY: "keep-this-provider-key" }, home);
    const server = deviceServer();
    const progress: string[] = [];
    const result = await authorizeDeepSeekHarness({
      authBaseUrl: "http://127.0.0.1:4173",
      dshHome: home,
      noOpen: true,
      fetchImpl: server.fetchImpl,
      sleep: async () => undefined,
      onProgress: (event) => progress.push(event.type),
    });

    expect(result).not.toHaveProperty("accessToken");
    expect(progress).toEqual(["authorization", "waiting", "completed"]);
    expect(server.requests[0]?.body.clientId).toBe("tmcra-deepseek-harness");
    expect(server.requests.at(-1)?.body.deliveryReceipt).toBe("r".repeat(43));
    const stored = parse(await readFile(credentialsPath(home), "utf8")) as Record<string, string>;
    expect(stored.DEEPSEEK_API_KEY).toBe("keep-this-provider-key");
    expect(stored.TMCRA_API_KEY).toMatch(/^tmcra_st_harness_test\./u);
    expect(stored.TMCRA_API_BASE_URL).toBe("https://api.tmcra.com");
    expect(stored.TMCRA_GLOBAL_SCOPE).toBe("personal-harness-test-global");
    expect(stored.TMCRA_PROJECT_SCOPE_PREFIX).toBe("personal-harness-test-project");
    await expect(readHarnessCredentialStatus(home)).resolves.toMatchObject({ configured: true });

    await logoutDeepSeekHarness(home);
    const afterLogout = parse(await readFile(credentialsPath(home), "utf8")) as Record<string, string>;
    expect(afterLogout).toEqual({ DEEPSEEK_API_KEY: "keep-this-provider-key" });
  });

  it("recovers an acknowledged delivery without starting a second authorization", async () => {
    const home = await temporaryHome();
    const failed = deviceServer({ failAcknowledgement: true });
    await expect(authorizeDeepSeekHarness({
      authBaseUrl: "http://127.0.0.1:4173",
      dshHome: home,
      noOpen: true,
      fetchImpl: failed.fetchImpl,
      sleep: async () => undefined,
    })).rejects.toThrow(/could not confirm delivery/u);

    const recoveredRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const recoveryFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      recoveredRequests.push({ url, body });
      return Response.json({ ok: true, claimed: true, expiresIn: 31_536_000 });
    };
    const result = await authorizeDeepSeekHarness({
      authBaseUrl: "http://127.0.0.1:4173",
      dshHome: home,
      noOpen: true,
      fetchImpl: recoveryFetch,
      sleep: async () => undefined,
    });
    expect(result.recovered).toBe(true);
    expect(recoveredRequests).toHaveLength(1);
    expect(recoveredRequests[0]?.url).toMatch(/\/api\/device\/v1\/token$/u);
    expect(recoveredRequests[0]?.body.deliveryReceipt).toBe("r".repeat(43));
  });

  it("rejects a device response issued for another provider", async () => {
    const home = await temporaryHome();
    const server = deviceServer({ provider: "codex" });
    await expect(authorizeDeepSeekHarness({
      authBaseUrl: "http://127.0.0.1:4173",
      dshHome: home,
      noOpen: true,
      fetchImpl: server.fetchImpl,
      sleep: async () => undefined,
    })).rejects.toThrow(/response is incomplete/u);
    await expect(readHarnessCredentialStatus(home)).resolves.toMatchObject({ configured: false });
  });
});
