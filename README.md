# TMCRA Memory for DeepSeek Harness

Automatic cross-conversation memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

This plugin connects Harness lifecycle events to the TMCRA Memory API. A new human prompt recalls account-global and current-project evidence in parallel, injects the resulting evidence into the model-visible session log, and writes the completed user/assistant turn back as two role-separated records.

The repository vendors the reviewable TypeScript client and lifecycle modules used by the adapter under `src/sdk/`. Hosted API, account, billing, control-plane, database, deployment, and production memory-engine code are not included.

> Status: technical preview. Verified with `@deepseek-ai/dsh` `0.1.0-rc.6` and TMCRA API `0.2.2`. DeepSeek Harness itself is currently a developer preview and may introduce breaking changes.

[中文说明](./README.zh-CN.md)

## What it does

- Recalls user-global and current-project memory before the first model request of each turn.
- Continues project work across separate Harness conversations.
- Keeps `session_id` as provenance inside a project scope; it does not create a third recall silo.
- Stores the human prompt and assistant result as distinct `user` and `assistant` records.
- Shares project memory across primary agents and subagents while preserving agent identity, role, parent session, and delegation depth in metadata.
- Derives a stable project scope from the Git origin, then the common Git directory, then the canonical workspace path.
- Redacts common API keys, bearer tokens, passwords, private keys, verification codes, and credential-bearing URLs before data crosses the TMCRA network boundary.
- Fails open on recall by default and keeps failed writeback in a crash-safe local outbox.

## Turn every project collaboration into knowledge you can keep using

The most valuable context in a long-running project is usually scattered across many conversations: why a requirement was chosen, which constraints shaped a design, what has already failed, where the implementation stopped, what the tests showed, and what should happen next. When a conversation ends, that context is easy to lose. Returning to the work often means explaining the project again, repeating investigations, or acting on conclusions that are no longer current.

With TMCRA connected, Harness records the goals, requirements, decisions, corrections, and working preferences expressed by the user. It also records the Agent's investigations, implementations, tests, diagnoses, and progress. User statements and Agent work remain distinct, so later conversations can tell the difference between a user decision, an Agent recommendation, and a result that was actually completed and verified.

As the project develops, those collaboration records are organized into:

- **Current project state:** goals, requirements, constraints, completed work, active problems, unfinished tasks, and suggested next steps;
- **Decision and implementation history:** why an approach was selected, important changes, experiments and test results, failed attempts, incident causes, and the solution that worked;
- **Reusable experience:** methods validated in real work, debugging paths, design principles, research notes, domain knowledge, and recurring pitfalls;
- **Personal working context:** explicitly stated preferences, habits, tools, collaboration patterns, and long-term interests.

This knowledge continues to change with the project. New conclusions update the current view while the earlier reasoning and history remain available. Separate projects stay separate, while conversations within the same project can share what has already been learned. At the start of a new conversation, the Agent can retrieve the project knowledge relevant to the current request before it answers or takes action.

Users can browse and search the memory library and knowledge graph in the TMCRA web or desktop app, return to the original conversation to verify an item, and delete memories that are incorrect, outdated, or no longer wanted. When local knowledge-base sync is enabled, stable project knowledge can also be organized into Obsidian for long-term personal use.

This is designed for development, research, product work, and multi-Agent collaboration that continues for weeks or months. It reduces repeated explanation, duplicated investigation, and repeated trial and error. Project progress can continue across conversations, and experience gained in one piece of work remains useful in the next.

## Requirements

- Node.js `22.19.0` or newer
- DeepSeek Harness `0.1.0-rc.6`
- `pnpm` on `PATH` for Harness plugin management
- A scoped TMCRA token with `memory:read` and `memory:write`

## Install the preview tarball

```bash
dsh plugin --profile web add https://github.com/reshuibuduo/tmcra-deepseek-harness-memory/releases/download/v0.1.0/tmcra-deepseek-harness-memory-0.1.0.tgz
dsh --profile web --dump-config
dsh web
```

Harness serves its Web UI at `http://127.0.0.1:3080` by default.

The package contributes `cordis.patch.yml`, so the install command activates the plugin in the selected profile. Prefer the prebuilt release tarball. A locally downloaded copy can also be installed with `dsh plugin --profile web add ./tmcra-deepseek-harness-memory-0.1.0.tgz`. Installing from a Git source may require an explicit `pnpm` build-script allowance.

On the current Harness preview for Windows, an absolute tarball path containing spaces or non-ASCII characters may be re-anchored incorrectly by `dsh plugin add`. If that happens, copy the tarball to a short path without spaces, such as `D:\\dsh-packages\\tmcra-deepseek-harness-memory-0.1.0.tgz`, and install from that path.

## Configure credentials

Store these references in `$DSH_HOME/.credentials.yaml`:

```yaml
TMCRA_API_KEY: "your-scoped-tmcra-token"
TMCRA_GLOBAL_SCOPE: "your-exact-account-global-scope"
TMCRA_PROJECT_SCOPE_PREFIX: "your-authorized-project-scope-prefix"
```

Use a short-lived, least-privilege token. Harness keeps the credential value out of settings and model requests, but any model-operated tool running under the same operating-system user may be able to read local files that user can read.

Default plugin configuration:

```yaml
- insert:
    - id: tmcra-memory
      name: tmcra-deepseek-harness-memory
      config:
        baseUrl: https://api.tmcra.com
        apiKeyEnv: TMCRA_API_KEY
        globalScopeEnv: TMCRA_GLOBAL_SCOPE
        projectScopePrefixEnv: TMCRA_PROJECT_SCOPE_PREFIX
        evidenceMode: auto
        recallFailureMode: continue
        waitForIngest: false
        recallTimeoutMs: 30000
        ingestTimeoutMs: 30000
```

`globalScope`, `projectScopePrefix`, and `projectScope` may be set explicitly for controlled deployments. Normal desktop use should keep automatic project derivation so different projects remain isolated while conversations inside the same project can continue one another. TMCRA uses the same `.tmcra/project.json` marker and Git-based scope formula as its Codex integration, allowing both tools to share one project memory graph.

## Lifecycle

```text
human prompt
  -> wait for prior project writeback
  -> reconcile the durable outbox
  -> recall global + project scopes
  -> append logged TMCRA evidence
  -> Harness model/tool loop
  -> successful turn end
  -> write USER and ASSISTANT separately
```

Recalled evidence uses Harness's durable plugin-message form (`form: recall`). It remains in the conversation until Harness compaction. TMCRA never rewrites or hides the local Harness transcript.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run pack:check
pnpm audit --prod
```

The public unit suite validates lifecycle hooks, scope derivation, role separation, redaction, recall injection, and the durable outbox. The production-service contract harness remains private because it imports TMCRA control-plane modules; its acceptance result is documented below without publishing the service implementation.

The opt-in remote test uses a real TMCRA account token and creates two isolated Harness conversations:

```bash
TMCRA_REMOTE_API_KEY=... \
TMCRA_REMOTE_CLEANUP_API_KEY=... \
TMCRA_REMOTE_GLOBAL_SCOPE=... \
TMCRA_REMOTE_PROJECT_SCOPE_PREFIX=... \
npm run test:remote
```

It verifies writeback, job completion, a clean-session recall, and an empty durable outbox. `TMCRA_REMOTE_CLEANUP_API_KEY` is optional and is used only to delete the disposable test sessions; the normal plugin token remains limited to `memory:read` and `memory:write`. The test uses a recording model adapter, so it validates the Harness/TMCRA lifecycle without spending model tokens.

On 2026-08-14, the preview passed a production API acceptance run: a new project wrote two completed turns as four role-separated memory records, and a second Harness conversation recalled both the user's checkpoint and the Agent's progress. The shared billing group recorded two ingest events (53 estimated tokens) and one effective recall under `deepseek_harness`, with per-member attribution to the test subject. The disposable group was cancelled and every test credential was revoked after verification.

## Current limits

- This preview has no TMCRA settings panel or device-authorization UI inside Harness.
- It does not import historical Harness conversations.
- Long-session context growth follows Harness's durable recall-message and compaction semantics and still needs workload characterization.
- Compatibility is tested only against Harness `0.1.0-rc.6`.
- The package has not yet been published to npm; the reviewed `.tgz` is the current installation artifact.
- A live DeepSeek-provider answer test requires the user's own DeepSeek credential; the memory lifecycle test itself does not require one.
- The memory library and knowledge graph are opened from the TMCRA web or desktop app; the Harness integration runs in the background during conversations.

## License

Apache License 2.0. Copyright 2026 Yu Haoxin and TMCRA contributors.
