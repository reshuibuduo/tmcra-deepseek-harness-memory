import z from "@deepseek-ai/schemastery";
import { ContentBlock, UserMessage } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
//#region src/sdk/models.d.ts
type EvidenceMode = "raw" | "auto" | "compiled";
//#endregion
//#region src/index.d.ts
declare const name = "tmcra-memory";
declare const inject: string[];
interface Config {
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
declare const Config: z<Config>;
declare function validateScope(value: string, field: string): string;
declare function blocksToText(blocks: readonly ContentBlock[]): string;
/**
 * Remove common credential forms before text crosses the TMCRA network boundary.
 * The original Harness transcript remains untouched; only recall queries,
 * recalled evidence, and remote memory records use the redacted copy.
 */
declare function redactSensitiveText(value: unknown): string;
declare function humanPrompt(messages: readonly UserMessage[]): string;
declare function assistantText(agent: Agent, turn: number): string;
declare function harnessAgentId(agent: Agent): string;
declare function turnKey(agent: Agent, turn: number): string;
declare function canonicalWorkspace(agent: Agent): string;
declare function projectIdentity(agent: Agent, configuredProjectId?: string): string;
declare function deriveProjectScope(prefix: string, agent: Agent, configuredProjectId?: string): string;
/** Register automatic TMCRA memory at native Harness lifecycle seams. */
declare function apply(ctx: Context, config: Config): void;
declare const testing: Readonly<{
  assistantText: typeof assistantText;
  blocksToText: typeof blocksToText;
  canonicalWorkspace: typeof canonicalWorkspace;
  deriveProjectScope: typeof deriveProjectScope;
  harnessAgentId: typeof harnessAgentId;
  humanPrompt: typeof humanPrompt;
  projectIdentity: typeof projectIdentity;
  redactSensitiveText: typeof redactSensitiveText;
  turnKey: typeof turnKey;
  validateScope: typeof validateScope;
}>;
//#endregion
export { Config, apply, inject, name, testing };