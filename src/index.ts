/**
 * TMCRA automatic-memory plugin for DeepSeek Harness.
 *
 * One admitted human prompt triggers recall before the first model request.
 * The recalled evidence is appended as a durable plugin-sourced user message,
 * so every model-visible byte remains present in the Harness session log.
 * When the turn reaches its successful stopping boundary, the same human
 * prompt and the assistant's visible text are ingested as two role-separated
 * records with stable idempotency.
 *
 * @module tmcra-deepseek-harness-memory
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContentBlock, UserMessage } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  FilePendingTurnQueue,
  PreparedTurn,
  TMCRAClient,
  TMCRAMemoryLifecycle,
} from "./sdk/index.ts";
import type { EvidenceMode, JsonValue } from "./sdk/index.ts";

export const name = "tmcra-memory";
export const inject = ["agents"];

const DEFAULT_BASE_URL = "https://api.tmcra.com";
const DEFAULT_API_KEY_ENV = "TMCRA_API_KEY";
const DEFAULT_GLOBAL_SCOPE_ENV = "TMCRA_GLOBAL_SCOPE";
const DEFAULT_PROJECT_SCOPE_PREFIX_ENV = "TMCRA_PROJECT_SCOPE_PREFIX";
const MAX_SCOPE_LENGTH = 128;

export interface Config {
  /** TMCRA Memory API base URL. */
  baseUrl?: string;
  /** Credential reference resolved from ctx.credentials on every operation. */
  apiKeyEnv?: string;
  /** Credential reference containing the exact account-global scope. */
  globalScopeEnv?: string;
  /** Credential reference containing the authorized project-scope prefix. */
  projectScopePrefixEnv?: string;
  /** Optional exact global scope for controlled deployments. Prefer globalScopeEnv. */
  globalScope?: string;
  /** Optional project-scope prefix for controlled deployments. Prefer projectScopePrefixEnv. */
  projectScopePrefix?: string;
  /** Optional exact project scope. Intended for controlled single-project deployments. */
  projectScope?: string;
  /** Optional stable project identifier when no `.tmcra/project.json` marker exists. */
  projectId?: string;
  evidenceMode?: EvidenceMode;
  recallFailureMode?: "raise" | "continue";
  /** Wait for the asynchronous writer job before allowing the turn to close. */
  waitForIngest?: boolean;
  recallTimeoutMs?: number;
  ingestTimeoutMs?: number;
  /** Durable outbox path. Defaults below DSH_HOME. */
  pendingQueuePath?: string;
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV),
  globalScopeEnv: z.string().default(DEFAULT_GLOBAL_SCOPE_ENV),
  projectScopePrefixEnv: z.string().default(DEFAULT_PROJECT_SCOPE_PREFIX_ENV),
  globalScope: z.string(),
  projectScopePrefix: z.string(),
  projectScope: z.string(),
  projectId: z.string(),
  evidenceMode: z.union(["raw", "auto", "compiled"]).default("auto"),
  recallFailureMode: z.union(["raise", "continue"]).default("continue"),
  waitForIngest: z.boolean().default(false),
  recallTimeoutMs: z.number().default(30_000),
  ingestTimeoutMs: z.number().default(30_000),
  pendingQueuePath: z.string(),
});

interface PreparedHarnessTurn {
  prepared: PreparedTurn;
  projectScope: string;
  agent: Agent;
}

interface ResolvedOperationConfig {
  apiKey: string;
  globalScope: string;
  projectScopePrefix: string;
}

function cleanText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`tmcra-memory: ${field} cannot be empty`);
  return normalized;
}

function validateScope(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(normalized)) {
    throw new Error(`tmcra-memory: ${field} is not a valid TMCRA scope`);
  }
  return normalized;
}

function validatePositiveTimeout(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error(`tmcra-memory: ${field} must be a positive safe integer`);
  }
  return resolved;
}

function hashText(value: string, length = 20): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function stringifyForRedaction(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

/**
 * Remove common credential forms before text crosses the TMCRA network boundary.
 * The original Harness transcript remains untouched; only recall queries,
 * recalled evidence, and remote memory records use the redacted copy.
 */
function redactSensitiveText(value: unknown): string {
  return stringifyForRedaction(value)
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu,
      "[REDACTED PRIVATE MATERIAL]",
    )
    .replace(
      /\b(?:sk[-_]|re_|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{20,}\b/gu,
      "[REDACTED TOKEN]",
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/gu, "[REDACTED ACCESS KEY]")
    .replace(
      /(\b(?:authorization|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|secret)\b\s*(?::|=|\bis\b)\s*["']?)[^\s"',;}<>]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /((?:验证码|校验码|一次性密码|密码|口令|密钥|私钥|令牌|OTP)\s*(?:是|为)?\s*[:：=]?\s*["']?)[^\s"',，。；;}<>]+/giu,
      "$1[REDACTED]",
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]{12,}/giu, "$1[REDACTED]")
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/giu, "$1[REDACTED]$2")
    .replace(/^\s*\d{4,10}\s*$/gu, "[REDACTED VERIFICATION CODE]");
}

function humanPrompt(messages: readonly UserMessage[]): string {
  const prompt = messages
    .filter((message) => message.source.kind === "user")
    .map((message) => blocksToText(message.content))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return redactSensitiveText(prompt).trim();
}

function turnEvents(agent: Agent, turn: number): SessionEvent[] {
  const events = [...agent.session.events];
  const startIndex = events.findLastIndex(
    (event) => event.type === "turn/start" && event.data.turn === turn,
  );
  return startIndex < 0 ? [] : events.slice(startIndex);
}

function assistantText(agent: Agent, turn: number): string {
  return turnEvents(agent, turn)
    .filter(
      (event): event is SessionEvent<"assistant/message"> =>
        event.type === "assistant/message" && event.data.turn === turn,
    )
    .map((event) => blocksToText(event.data.message.content))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function harnessAgentId(agent: Agent): string {
  const header = agent.session.header;
  if (header.agentPreset?.trim()) return `dsh-preset:${header.agentPreset.trim()}`;
  if (header.origin === "subagent") return `dsh-subagent:${String(header.id)}`;
  return `dsh-agent:${String(agent.id)}`;
}

function turnKey(agent: Agent, turn: number): string {
  return `${String(agent.session.header.id)}:${turn}`;
}

function agentMetadata(agent: Agent): Readonly<Record<string, JsonValue>> {
  const header = agent.session.header;
  return Object.freeze({
    agent_id: harnessAgentId(agent),
    agent_name: header.agentPreset?.trim() || (header.origin === "subagent" ? "DeepSeek Harness subagent" : "DeepSeek Harness agent"),
    agent_role: header.origin === "subagent" ? "subagent" : "primary",
    agent_team: "deepseek-harness",
    harness_session_id: String(header.id),
    ...(header.parentSession ? { parent_session_id: String(header.parentSession) } : {}),
    ...(header.delegationDepth !== undefined ? { delegation_depth: header.delegationDepth } : {}),
  });
}

function canonicalWorkspace(agent: Agent): string {
  const normalized = resolve(agent.session.header.cwd ?? process.cwd()).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function gitDirectory(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    const marker = join(current, ".git");
    if (existsSync(marker)) {
      if (statSync(marker).isDirectory()) return marker;
      const directive = readFileSync(marker, "utf8").match(/^gitdir:\s*(.+)$/im)?.[1]?.trim();
      if (!directive) return undefined;
      const worktreeGitDirectory = resolve(current, directive);
      const commonDirectivePath = join(worktreeGitDirectory, "commondir");
      if (!existsSync(commonDirectivePath)) return worktreeGitDirectory;
      return resolve(worktreeGitDirectory, readFileSync(commonDirectivePath, "utf8").trim());
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function parseGitOrigin(configText: string): string | undefined {
  let section = "";
  for (const rawLine of configText.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim();
      continue;
    }
    if (section === 'remote "origin"') {
      const match = line.match(/^url\s*=\s*(.+)$/u);
      if (match) return match[1]!.trim().replace(/\.git$/u, "");
    }
  }
  return undefined;
}

function gitOrigin(start: string): string | undefined {
  const directory = gitDirectory(start);
  if (!directory) return undefined;
  const configPath = join(directory, "config");
  if (!existsSync(configPath)) return undefined;
  return parseGitOrigin(readFileSync(configPath, "utf8"));
}

interface ProjectDescriptor {
  identity: string;
  display: string;
  exactScope?: string;
}

function normalizeIdentity(value: string): string {
  const normalized = resolve(value).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectSlug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 36);
  return normalized || "project";
}

function findProjectMarker(start: string): ProjectDescriptor | undefined {
  let current = resolve(start);
  while (true) {
    const markerPath = join(current, ".tmcra", "project.json");
    if (existsSync(markerPath)) {
      try {
        const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
        const id = String(marker.projectId ?? marker.project_id ?? marker.id ?? "").trim();
        if (id) {
          const configuredName = String(marker.name ?? "").trim();
          const exactScope = String(marker.scopeName ?? marker.scope_name ?? "").trim();
          return {
            identity: `tmcra:${id}`,
            display: configuredName || current.split(/[\\/]/u).at(-1) || "project",
            ...(exactScope ? { exactScope: validateScope(exactScope, "marker scopeName") } : {}),
          };
        }
      } catch {
        // Ignore malformed optional markers and continue with Git/path identity.
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function projectDescriptor(agent: Agent, configuredProjectId?: string): ProjectDescriptor {
  const workspace = canonicalWorkspace(agent);
  const marker = findProjectMarker(workspace);
  const projectId = cleanText(configuredProjectId, "projectId");
  if (projectId) {
    return {
      identity: `configured:${projectId}`,
      display: projectId,
      ...(marker?.exactScope ? { exactScope: marker.exactScope } : {}),
    };
  }
  if (marker) return marker;
  const remote = gitOrigin(workspace);
  if (remote) {
    return {
      identity: `git:${remote}`,
      display: remote.split(/[/:]/u).at(-1) || "project",
    };
  }
  const directory = gitDirectory(workspace);
  if (directory) {
    const root = dirname(directory);
    return { identity: `git-root:${normalizeIdentity(root)}`, display: root.split(/[\\/]/u).at(-1) || "project" };
  }
  return { identity: `path:${normalizeIdentity(workspace)}`, display: workspace.split("/").at(-1) || "project" };
}

function projectIdentity(agent: Agent, configuredProjectId?: string): string {
  return projectDescriptor(agent, configuredProjectId).identity;
}

function deriveProjectScope(prefix: string, agent: Agent, configuredProjectId?: string): string {
  const project = projectDescriptor(agent, configuredProjectId);
  if (project.exactScope) return project.exactScope;
  const candidate = `${prefix}-${projectSlug(project.display)}-${hashText(project.identity, 16)}`;
  if (candidate.length > MAX_SCOPE_LENGTH) {
    throw new Error("tmcra-memory: projectScopePrefix is too long for a derived project scope; configure projectScope explicitly");
  }
  return validateScope(candidate, "derived project scope");
}

function defaultPendingQueuePath(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), ".dsh");
  return join(dshHome, "tmcra", "deepseek-harness-pending-turns.json");
}

async function resolveCredential(ctx: Context, reference: string): Promise<string | undefined> {
  const ref = credentialRef(reference);
  const credentials = ctx.get("credentials");
  const value = credentials === undefined
    ? process.env[ref]
    : (await credentials.resolve(ref))?.value;
  return cleanText(value, reference);
}

async function resolveOperationConfig(ctx: Context, config: Config): Promise<ResolvedOperationConfig> {
  const apiKeyReference = cleanText(config.apiKeyEnv, "apiKeyEnv") ?? DEFAULT_API_KEY_ENV;
  const apiKey = await resolveCredential(ctx, apiKeyReference);
  if (!apiKey) throw new Error(`tmcra-memory: credential ${apiKeyReference} is not configured`);
  const globalReference = cleanText(config.globalScopeEnv, "globalScopeEnv") ?? DEFAULT_GLOBAL_SCOPE_ENV;
  const globalScope = cleanText(config.globalScope, "globalScope") ?? await resolveCredential(ctx, globalReference);
  if (!globalScope) throw new Error(`tmcra-memory: exact global scope ${globalReference} is not configured`);
  const projectPrefixReference = cleanText(config.projectScopePrefixEnv, "projectScopePrefixEnv")
    ?? DEFAULT_PROJECT_SCOPE_PREFIX_ENV;
  const projectScopePrefix = cleanText(config.projectScopePrefix, "projectScopePrefix")
    ?? await resolveCredential(ctx, projectPrefixReference);
  if (!projectScopePrefix) {
    throw new Error(`tmcra-memory: project scope prefix ${projectPrefixReference} is not configured`);
  }
  return {
    apiKey,
    globalScope: validateScope(globalScope, "globalScope"),
    projectScopePrefix: validateScope(projectScopePrefix, "projectScopePrefix"),
  };
}

function recalledMessage(prepared: PreparedTurn): UserMessage | undefined {
  if (!prepared.systemContext.trim()) return undefined;
  const text = redactSensitiveText(prepared.systemContext);
  return createUserMessage({
    content: [{ type: "text", text }],
    source: {
      kind: "plugin",
      plugin: name,
      form: "recall",
    },
  });
}

function lifecycleFor(
  config: Config,
  operation: ResolvedOperationConfig,
  agent: Agent,
  projectScope: string,
  pendingQueue: FilePendingTurnQueue,
  stage: "recall" | "ingest",
): TMCRAMemoryLifecycle {
  const assistantAgentId = harnessAgentId(agent);
  const client = new TMCRAClient({
    baseUrl: cleanText(config.baseUrl, "baseUrl") ?? DEFAULT_BASE_URL,
    apiKey: operation.apiKey,
    defaultTimeoutMs: stage === "recall"
      ? validatePositiveTimeout(config.recallTimeoutMs, 30_000, "recallTimeoutMs")
      : validatePositiveTimeout(config.ingestTimeoutMs, 30_000, "ingestTimeoutMs"),
    clientPlatform: "deepseek_harness",
    integrationId: "tmcra-deepseek-harness",
    agentId: assistantAgentId,
  });
  return new TMCRAMemoryLifecycle(client, {
    projectScope,
    globalScope: operation.globalScope,
    evidenceMode: config.evidenceMode ?? "auto",
    recallFailOpen: (config.recallFailureMode ?? "continue") === "continue",
    waitForIngest: config.waitForIngest ?? false,
    waitForJob: {
      timeoutMs: validatePositiveTimeout(config.ingestTimeoutMs, 30_000, "ingestTimeoutMs"),
    },
    pendingQueue,
    source: "deepseek-harness",
    agentMetadata: agentMetadata(agent),
  });
}

function warn(ctx: Context, stage: "recall" | "ingest", error: unknown): void {
  ctx.logger.warn(`tmcra-memory: ${stage} failed; the Harness turn will continue`);
  ctx.logger.warn(error);
}

/** Register automatic TMCRA memory at native Harness lifecycle seams. */
export function apply(ctx: Context, config: Config): void {
  validatePositiveTimeout(config.recallTimeoutMs, 30_000, "recallTimeoutMs");
  validatePositiveTimeout(config.ingestTimeoutMs, 30_000, "ingestTimeoutMs");
  const preparedByAgentTurn = new Map<string, PreparedHarnessTurn>();
  // Serialize on the shared project scope so a new Harness conversation cannot
  // recall before the prior conversation has submitted its final writeback.
  const writebackByProject = new Map<string, Promise<void>>();
  const pendingQueue = new FilePendingTurnQueue(
    cleanText(config.pendingQueuePath, "pendingQueuePath") ?? defaultPendingQueuePath(),
  );
  const detached = new Set<Promise<void>>();

  const track = (operation: Promise<void>): void => {
    detached.add(operation);
    void operation.finally(() => detached.delete(operation));
  };
  ctx.effect(
    () => async () => { await Promise.allSettled([...detached]); },
    "tmcra-memory: drain writeback",
  );

  const reconcilePending = async (
    agent: Agent,
    operation: ResolvedOperationConfig,
    projectScope: string,
  ): Promise<void> => {
    await writebackByProject.get(projectScope);
    if ((await pendingQueue.list()).length === 0) return;
    const lifecycle = lifecycleFor(
      config,
      operation,
      agent,
      projectScope,
      pendingQueue,
      "ingest",
    );
    const results = await lifecycle.reconcilePendingTurns({
      waitForIngest: true,
      waitForJob: {
        timeoutMs: validatePositiveTimeout(config.ingestTimeoutMs, 30_000, "ingestTimeoutMs"),
      },
    });
    for (const result of results) {
      if (result.status === "succeeded") continue;
      warn(ctx, "ingest", new Error(
        `pending turn ${result.key} remains ${result.status}${result.error ? `: ${result.error}` : ""}`,
      ));
    }
  };

  ctx.on("agent/pre-step", async (
    { agent, messages, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const downstream = await next();
    if (downstream.kind === "reject" || signal.aborted || step !== 1) return downstream;
    const prompt = humanPrompt(downstream.messages);
    if (!prompt) return downstream;

    const key = turnKey(agent, turn);
    try {
      const operation = await resolveOperationConfig(ctx, config);
      const projectScope = cleanText(config.projectScope, "projectScope")
        ? validateScope(config.projectScope!, "projectScope")
        : deriveProjectScope(operation.projectScopePrefix, agent, config.projectId);
      await reconcilePending(agent, operation, projectScope);
      const lifecycle = lifecycleFor(config, operation, agent, projectScope, pendingQueue, "recall");
      const prepared = await lifecycle.prepareTurn(prompt, {
        sessionId: String(agent.session.header.id),
        turnId: String(turn),
      });
      preparedByAgentTurn.set(key, {
        prepared,
        projectScope,
        agent,
      });
      const context = recalledMessage(prepared);
      return context
        ? { kind: "enter", messages: [...downstream.messages, context] }
        : downstream;
    } catch (error) {
      preparedByAgentTurn.delete(key);
      if ((config.recallFailureMode ?? "continue") === "raise") throw error;
      warn(ctx, "recall", error);
      return downstream;
    }
  }, { prepend: true });

  ctx.on("session/event", (session, event) => {
    if (event.type !== "turn/end") return;
    const key = `${String(session.header.id)}:${event.data.turn}`;
    const state = preparedByAgentTurn.get(key);
    if (!state) return;
    preparedByAgentTurn.delete(key);
    if (event.data.reason.kind !== "completed") return;
    const answer = assistantText(state.agent, event.data.turn);
    if (!answer) return;

    const projectScope = state.projectScope;
    const previous = writebackByProject.get(projectScope) ?? Promise.resolve();
    const writeback = previous.catch(() => undefined).then(async () => {
      try {
        const operation = await resolveOperationConfig(ctx, config);
        const lifecycle = lifecycleFor(
          config,
          operation,
          state.agent,
          state.projectScope,
          pendingQueue,
          "ingest",
        );
        await lifecycle.commitTurn(state.prepared, redactSensitiveText(answer));
      } catch (error) {
        warn(ctx, "ingest", error);
      }
    });
    writebackByProject.set(projectScope, writeback);
    track(writeback.finally(() => {
      if (writebackByProject.get(projectScope) === writeback) writebackByProject.delete(projectScope);
    }));
  });

  ctx.on("agent/disposed", ({ agent }) => {
    const prefix = `${String(agent.session.header.id)}:`;
    for (const key of preparedByAgentTurn.keys()) {
      if (key.startsWith(prefix)) preparedByAgentTurn.delete(key);
    }
  });
}

export const testing = Object.freeze({
  assistantText,
  blocksToText,
  canonicalWorkspace,
  deriveProjectScope,
  harnessAgentId,
  humanPrompt,
  projectIdentity,
  redactSensitiveText,
  turnKey,
  validateScope,
});
