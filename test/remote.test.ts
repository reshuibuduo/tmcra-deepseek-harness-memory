import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { mountAgentLoopTestDependencies } from "@deepseek-ai/dsh-agent-loop-testkit";
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { expect, it } from "vitest";
import { apply } from "../src/index.ts";

const apiKey = process.env.TMCRA_REMOTE_API_KEY?.trim();
const cleanupApiKey = process.env.TMCRA_REMOTE_CLEANUP_API_KEY?.trim();
const globalScope = process.env.TMCRA_REMOTE_GLOBAL_SCOPE?.trim();
const projectScopePrefix = process.env.TMCRA_REMOTE_PROJECT_SCOPE_PREFIX?.trim();
const baseUrl = process.env.TMCRA_REMOTE_BASE_URL?.trim() || "https://api.tmcra.com";
const enabled = Boolean(apiKey && globalScope && projectScopePrefix);

async function deleteSession(scope: string, sessionId: string): Promise<void> {
  if (!cleanupApiKey) return;
  const response = await fetch(
    `${baseUrl}/v1/scopes/${encodeURIComponent(scope)}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${cleanupApiKey}`,
        "idempotency-key": `dsh-cleanup-${randomUUID()}`,
        "x-tmcra-confirm-session": sessionId,
      },
    },
  );
  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(`remote smoke cleanup failed with HTTP ${response.status}`);
  }
}

function chunks(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  constructor(private readonly answers: readonly string[]) {
    super();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const answer = this.answers[this.requests.length - 1];
    if (!answer) throw new Error("remote smoke adapter script exhausted");
    for (const chunk of chunks(answer)) yield chunk;
  }
}

function send(agent: ReturnType<Context["agentLoop"]["create"]>, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  }));
}

function requestText(request: GenerateOptions): string {
  return request.messages.flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n");
}

it.skipIf(!enabled)("continues work through TMCRA in a new real Harness conversation", async () => {
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const projectScope = `${projectScopePrefix}-dsh-e2e-${runId}`;
  const firstSessionId = `dsh-e2e-${runId}-a`;
  const secondSessionId = `dsh-e2e-${runId}-b`;
  const userMarker = `TMCRA_USER_${runId}`;
  const answerMarker = `TMCRA_AGENT_${runId}`;
  const pendingDirectory = await mkdtemp(join(tmpdir(), "tmcra-dsh-remote-"));
  const pendingQueuePath = join(pendingDirectory, "pending-turns.json");
  const priorKey = process.env.TMCRA_DSH_REMOTE_KEY;
  const priorGlobalScope = process.env.TMCRA_DSH_REMOTE_GLOBAL_SCOPE;
  const priorProjectPrefix = process.env.TMCRA_DSH_REMOTE_PROJECT_PREFIX;
  process.env.TMCRA_DSH_REMOTE_KEY = apiKey!;
  process.env.TMCRA_DSH_REMOTE_GLOBAL_SCOPE = globalScope!;
  process.env.TMCRA_DSH_REMOTE_PROJECT_PREFIX = projectScopePrefix!;

  const context = new Context();
  const adapter = new RecordingAdapter([
    `Implementation checkpoint recorded: ${answerMarker}`,
    "Continuation verified in a clean Harness conversation.",
  ]);

  try {
    const health = await fetch(`${baseUrl}/healthz`);
    expect(health.ok).toBe(true);
    await mountAgentLoopTestDependencies(context);
    await context.plugin(AgentLoop, { agents: [] });
    context.llm.registerAdapter(["tmcra-remote-mock"], adapter);
    await context.plugin({ name: "tmcra-remote-test", inject: ["agents"], apply }, {
      baseUrl,
      apiKeyEnv: "TMCRA_DSH_REMOTE_KEY",
      globalScopeEnv: "TMCRA_DSH_REMOTE_GLOBAL_SCOPE",
      projectScopePrefixEnv: "TMCRA_DSH_REMOTE_PROJECT_PREFIX",
      projectScope,
      pendingQueuePath,
      waitForIngest: true,
      // A new Harness project has no active TMCRA snapshot yet. The first
      // recall therefore fails open, the completed turn creates the scope,
      // and the second conversation must recover both sides of that turn.
      recallFailureMode: "continue",
      recallTimeoutMs: 60_000,
      ingestTimeoutMs: 120_000,
    });

    const first = context.agentLoop.create(
      SessionId(firstSessionId),
      { provider: "tmcra-remote-mock", model: "lifecycle-recorder" },
      { cwd: process.cwd() },
    );
    send(first, `Record this project checkpoint: ${userMarker}`);
    await first.whenIdle();

    const nextConversation = context.agentLoop.create(
      SessionId(secondSessionId),
      { provider: "tmcra-remote-mock", model: "lifecycle-recorder" },
      { cwd: process.cwd() },
    );
    send(nextConversation, "Continue from the most recent project checkpoint.");
    await nextConversation.whenIdle();
    await context.fiber.dispose();

    expect(adapter.requests).toHaveLength(2);
    const cleanConversationRequest = requestText(adapter.requests[1]!);
    expect(cleanConversationRequest).toContain(userMarker);
    expect(cleanConversationRequest).toContain(answerMarker);
    expect(nextConversation.session.events.some((event) =>
      event.type === "user/message"
      && event.data.source.kind === "plugin"
      && event.data.source.plugin === "tmcra-memory"
      && event.data.source.form === "recall"))
      .toBe(true);

    const queue = JSON.parse(await readFile(pendingQueuePath, "utf8")) as {
      records?: Record<string, unknown>;
    };
    expect(Object.keys(queue.records ?? {})).toHaveLength(0);
  } finally {
    await context.fiber.dispose();
    await Promise.allSettled([
      deleteSession(projectScope, firstSessionId),
      deleteSession(projectScope, secondSessionId),
    ]);
    if (priorKey === undefined) delete process.env.TMCRA_DSH_REMOTE_KEY;
    else process.env.TMCRA_DSH_REMOTE_KEY = priorKey;
    if (priorGlobalScope === undefined) delete process.env.TMCRA_DSH_REMOTE_GLOBAL_SCOPE;
    else process.env.TMCRA_DSH_REMOTE_GLOBAL_SCOPE = priorGlobalScope;
    if (priorProjectPrefix === undefined) delete process.env.TMCRA_DSH_REMOTE_PROJECT_PREFIX;
    else process.env.TMCRA_DSH_REMOTE_PROJECT_PREFIX = priorProjectPrefix;
    await rm(pendingDirectory, { recursive: true, force: true });
  }
}, 180_000);
