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

## From project work to accumulated knowledge

The plugin continuously captures both sides of real project work: the goals, constraints, decisions, corrections, and preferences expressed by the user, together with the investigations, implementations, changes, and progress produced by the Agent. Every record keeps its actor and source provenance. TMCRA then organizes the committed evidence in the background.

As a project develops, TMCRA can derive:

- project memory: requirements, decisions, milestones, current state, incidents, and open questions;
- reusable knowledge: concepts, methods, explanations, research notes, and lessons learned;
- personal context: explicit profile facts, preferences, and people;
- a viewable memory and knowledge graph (`Visual Atlas`) plus a personal knowledge base, where claims remain linked to supporting evidence and carry `confirmed`, `provisional`, `superseded`, or `open` status.

Users can inspect these results in the TMCRA web console and desktop application. The graph and knowledge base can be regenerated as memory changes without rewriting the original source records. This Harness plugin handles capture, recall, injection, and writeback; the TMCRA service performs the later graph and knowledge curation.

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
- The Visual Atlas and personal knowledge base are viewed in TMCRA clients; this preview does not embed those viewers inside Harness.

## License

Apache License 2.0. Copyright 2026 Yu Haoxin and TMCRA contributors.
