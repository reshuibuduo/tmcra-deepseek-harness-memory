#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  authorizeDeepSeekHarness,
  logoutDeepSeekHarness,
  readHarnessCredentialStatus,
} from "./device-auth.js";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function printJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function main() {
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
        } else if (event.type === "waiting") {
          process.stderr.write("Waiting for approval in your TMCRA account...\n");
        } else if (event.type === "network_retry") {
          process.stderr.write("TMCRA authorization network retry in progress...\n");
        }
      },
    });
    if (json) printJson({ ok: true, ...result });
    else process.stdout.write(`TMCRA is connected. Harness credentials were saved to ${result.credentialsPath}.\n`);
    return;
  }
  if (command === "status") {
    const status = await readHarnessCredentialStatus(dshHome);
    if (json) printJson({ ok: true, ...status });
    else process.stdout.write(status.configured
      ? `TMCRA is configured in ${status.credentialsPath}.\n`
      : `TMCRA is not configured. Run: tmcra-harness-memory login\n`);
    return;
  }
  if (command === "logout") {
    const path = await logoutDeepSeekHarness(dshHome);
    if (json) printJson({ ok: true, configured: false, credentialsPath: path });
    else process.stdout.write(`TMCRA credentials were removed from ${path}. Revoke the connection in your TMCRA account if this device is no longer trusted.\n`);
    return;
  }
  process.stdout.write(`Usage:\n  tmcra-harness-memory login [--no-open] [--auth-base-url URL] [--dsh-home PATH] [--json]\n  tmcra-harness-memory status [--dsh-home PATH] [--json]\n  tmcra-harness-memory logout [--dsh-home PATH] [--json]\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "TMCRA login failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
