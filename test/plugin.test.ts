import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
import { apply, testing, type Config } from "../src/index.ts";

interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface MockMemoryServer {
  baseUrl: string;
  calls: RecordedCall[];
  close(): Promise<void>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function textResponse(text: string): StreamChunk[] {
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

  constructor(private readonly answers: string[]) {
    super();
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error("test adapter script exhausted");
    for (const chunk of textResponse(answer)) yield chunk;
  }
}

function responseJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function job(id: string, scope: string, status = "succeeded") {
  return {
    job_id: id,
    tenant_id: "tenant-test",
    scope_name: scope,
    job_type: "ingest",
    status,
    attempts: 1,
    created_at: 1,
    updated_at: 2,
    started_at: 1,
    finished_at: status === "succeeded" ? 2 : null,
    heartbeat_at: null,
    lease_expires_at: null,
    result: null,
    error: null,
    status_url: `/v1/jobs/${id}`,
  };
}

function recall(scope: string, content: string) {
  return {
    query_id: `query-${scope}`,
    scope_name: scope,
    index_job_id: "index-test",
    evidence_route: { requested: "auto", selected: "raw", reasons: [] },
    evidence: {},
    prompt_evidence: {
      schema_version: "tmcra.prompt-evidence.1",
      format: "text/plain",
      mode: "raw_hierarchical",
      content,
      content_sha256: "test-hash",
      content_character_count: content.length,
      source_text_verbatim: true,
      trust_boundary: "untrusted",
    },
    debug: null,
  };
}

async function startMemoryServer(options: { failRecall?: boolean; failIngest?: boolean } = {}): Promise<MockMemoryServer> {
  const calls: RecordedCall[] = [];
  const memories = new Map<string, string[]>();
  const jobs = new Map<string, ReturnType<typeof job>>();
  let jobSequence = 0;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const body = await requestBody(request);
      calls.push({
        method: request.method ?? "GET",
        path: url.pathname,
        headers: request.headers,
        body,
      });
      const recallMatch = url.pathname.match(/^\/v1\/scopes\/([^/]+)\/recall$/);
      if (recallMatch) {
        if (options.failRecall) return responseJson(response, 503, { detail: "recall unavailable" });
        const scope = decodeURIComponent(recallMatch[1]!);
        const stored = memories.get(scope) ?? [];
        const content = scope.endsWith("global")
          ? "The user prefers concise engineering answers."
          : stored.join("\n");
        return responseJson(response, 200, recall(scope, content));
      }
      const ingestMatch = url.pathname.match(/^\/v1\/scopes\/([^/]+)\/ingest$/);
      if (ingestMatch) {
        if (options.failIngest) return responseJson(response, 503, { detail: "ingest unavailable" });
        const scope = decodeURIComponent(ingestMatch[1]!);
        const messages = (body as { messages?: Array<{ content?: unknown }> } | undefined)?.messages ?? [];
        const stored = memories.get(scope) ?? [];
        for (const message of messages) {
          if (typeof message.content === "string") stored.push(message.content);
        }
        memories.set(scope, stored);
        const id = `job-${++jobSequence}`;
        const view = job(id, scope);
        jobs.set(id, view);
        return responseJson(response, 202, view);
      }
      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (jobMatch) {
        const view = jobs.get(decodeURIComponent(jobMatch[1]!));
        return responseJson(response, view ? 200 : 404, view ?? { detail: "not found" });
      }
      return responseJson(response, 404, { detail: "not found" });
    } catch (error) {
      return responseJson(response, 500, { detail: String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not bind TCP");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function testContext(server: MockMemoryServer, adapter: RecordingAdapter, options: Partial<Config> = {}) {
  const context = new Context();
  await mountAgentLoopTestDependencies(context);
  await context.plugin(AgentLoop, { agents: [] });
  context.llm.registerAdapter(["mock"], adapter);
  const directory = await mkdtemp(join(tmpdir(), "tmcra-dsh-plugin-"));
  temporaryDirectories.push(directory);
  process.env.TMCRA_TEST_KEY = "test-token";
  process.env.TMCRA_TEST_GLOBAL = "test-global";
  process.env.TMCRA_TEST_PROJECT_PREFIX = "test-project";
  await context.plugin({ name: "tmcra-test", inject: ["agents"], apply }, {
    baseUrl: server.baseUrl,
    apiKeyEnv: "TMCRA_TEST_KEY",
    globalScopeEnv: "TMCRA_TEST_GLOBAL",
    projectScopePrefixEnv: "TMCRA_TEST_PROJECT_PREFIX",
    pendingQueuePath: join(directory, "pending-turns.json"),
    waitForIngest: false,
    recallTimeoutMs: 2_000,
    ingestTimeoutMs: 2_000,
    ...options,
  });
  return { context, directory };
}

function send(agent: ReturnType<Context["agentLoop"]["create"]>, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  }));
}

function messageText(options: GenerateOptions): string {
  return options.messages.flatMap((message) => message.content)
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n");
}

describe("TMCRA DeepSeek Harness plugin", () => {
  it("injects recall into the real Harness model request and writes USER/AGENT separately", async () => {
    const server = await startMemoryServer();
    const adapter = new RecordingAdapter(["First answer: parser plan is complete.", "Second answer: continuing implementation."]);
    const { context } = await testContext(server, adapter, {
      projectScope: "test-project-a",
      globalScope: "test-global",
    });
    try {
      const firstAgent = context.agentLoop.create(
        SessionId("harness-session-a"),
        { provider: "mock", model: "mock" },
        { cwd: process.cwd() },
      );
      send(firstAgent, "Plan the parser change");
      await firstAgent.whenIdle();
      const nextConversation = context.agentLoop.create(
        SessionId("harness-session-b"),
        { provider: "mock", model: "mock" },
        { cwd: process.cwd() },
      );
      send(nextConversation, "Continue from the latest project progress");
      await nextConversation.whenIdle();
      await context.fiber.dispose();

      expect(adapter.requests).toHaveLength(2);
      expect(messageText(adapter.requests[0]!)).toContain("The user prefers concise engineering answers.");
      expect(messageText(adapter.requests[1]!)).toContain("First answer: parser plan is complete.");
      const pluginEvents = [...firstAgent.session.events, ...nextConversation.session.events].filter((event) =>
        event.type === "user/message"
        && event.data.source.kind === "plugin"
        && event.data.source.plugin === "tmcra-memory");
      expect(pluginEvents).toHaveLength(2);
      expect(pluginEvents.every((event) =>
        event.type === "user/message" && event.data.source.kind === "plugin" && event.data.source.form === "recall"))
        .toBe(true);

      const ingests = server.calls.filter((call) => call.path.endsWith("/ingest"));
      expect(ingests).toHaveLength(2);
      for (const call of ingests) {
        const payload = call.body as { messages: Array<{ role: string; metadata?: Record<string, unknown> }>; metadata?: Record<string, unknown> };
        expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(payload.messages[0]?.metadata?.actor_role).toBe("user");
        expect(payload.messages[1]?.metadata?.actor_role).toBe("assistant");
        expect(payload.metadata?.agent_team).toBe("deepseek-harness");
        expect(call.headers["idempotency-key"]).toMatch(/^tmcra-turn-[a-f0-9]{48}$/);
      }
    } finally {
      await context.fiber.dispose();
      await server.close();
    }
  });

  it("redacts credentials before recall and role-separated remote writeback", async () => {
    const server = await startMemoryServer();
    const adapter = new RecordingAdapter(["api_key=HARNESS_ASSISTANT_SECRET_5678"]);
    const { context } = await testContext(server, adapter, {
      projectScope: "test-project-redaction",
      globalScope: "test-global-redaction",
    });
    try {
      const agent = context.agentLoop.create(
        SessionId("harness-session-redaction"),
        { provider: "mock", model: "mock" },
      );
      send(agent, "password: HARNESS_USER_SECRET_1234");
      await agent.whenIdle();
      await context.fiber.dispose();

      const remoteTraffic = JSON.stringify(server.calls.map((call) => call.body));
      expect(remoteTraffic).not.toContain("HARNESS_USER_SECRET_1234");
      expect(remoteTraffic).not.toContain("HARNESS_ASSISTANT_SECRET_5678");
      expect(remoteTraffic).toContain("[REDACTED]");
    } finally {
      await context.fiber.dispose();
      await server.close();
    }
  });

  it("fails open when recall is unavailable and keeps a durable outbox when ingest fails", async () => {
    const server = await startMemoryServer({ failRecall: true, failIngest: true });
    const adapter = new RecordingAdapter(["The Harness can still answer."]);
    const { context, directory } = await testContext(server, adapter, {
      projectScope: "test-project-failure",
      globalScope: "test-global-failure",
      recallFailureMode: "continue",
    });
    try {
      const agent = context.agentLoop.create(SessionId("harness-session-failure"), { provider: "mock", model: "mock" });
      send(agent, "Continue even if memory is down");
      await agent.whenIdle();
      await context.fiber.dispose();
      expect(adapter.requests).toHaveLength(1);
      expect(messageText(adapter.requests[0]!)).not.toContain("tmcra-memory-context");
      const queue = JSON.parse(await readFile(join(directory, "pending-turns.json"), "utf8")) as { records: Record<string, unknown> };
      expect(Object.keys(queue.records)).toHaveLength(1);
    } finally {
      await context.fiber.dispose();
      await server.close();
    }
  });

  it("derives a shared project scope from one Git origin and isolates another project", async () => {
    const externalTemporaryRoot = process.env.TMCRA_EXTERNAL_TEST_TMP || tmpdir();
    await mkdir(externalTemporaryRoot, { recursive: true });
    const root = await mkdtemp(join(externalTemporaryRoot, "tmcra-dsh-scope-"));
    temporaryDirectories.push(root);
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    const projectC = join(root, "project-c");
    for (const project of [projectA, projectB, projectC]) await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(join(projectA, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:tmcra/memory-os.git\n', "utf8");
    await writeFile(join(projectB, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:tmcra/memory-os.git\n', "utf8");
    await writeFile(join(projectC, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/tmcra/another-project.git\n', "utf8");
    const fakeAgent = (cwd: string) => ({ session: { header: { cwd } } }) as never;
    expect(testing.deriveProjectScope("acct-project", fakeAgent(projectA)))
      .toBe(testing.deriveProjectScope("acct-project", fakeAgent(projectB)));
    expect(testing.deriveProjectScope("acct-project", fakeAgent(projectA)))
      .not.toBe(testing.deriveProjectScope("acct-project", fakeAgent(projectC)));
  });
});
