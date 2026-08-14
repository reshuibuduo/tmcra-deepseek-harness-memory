# Changelog

## 0.1.0 - 2026-08-14

Technical preview for DeepSeek Harness `0.1.0-rc.6`.

- Recall account-global and current-project memory before the first model request.
- Inject traceable TMCRA evidence into the durable Harness session log.
- Write user and assistant turns as separate records after a successful turn.
- Preserve project, session, agent, parent-agent, and delegation provenance.
- Redact common credential forms before network transmission.
- Retain failed writeback in a crash-safe local outbox.
- Attribute usage to the `deepseek_harness` platform ledger.
