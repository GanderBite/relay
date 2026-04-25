# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-04-25

### Added

#### @relay/core
- `defineFlow` / `step.*` DSL for declaring deterministic multi-step flows
- `Orchestrator` with checkpoint/resume, DAG scheduling, and parallel step execution
- \`ClaudeCliProvider\` — subscription-safe Claude backend with env allowlist suppression
- `MockProvider` for deterministic unit testing without live Claude calls
- `ProviderRegistry` for registering custom provider backends
- `HandoffStore` for typed, schema-validated inter-step data passing
- `CostTracker` — per-step token and USD cost accounting with `metrics.json` persistence
- `StateMachine` — atomic state transitions with crash-proof `state.json` writes
- `onStepComplete` lifecycle hook on `RunOptions` for embedding hosts
- `withRetry` — configurable retry with exponential backoff and rate-limit awareness
- Full error hierarchy: `PipelineError`, `StepFailureError`, `FlowDefinitionError`, `ClaudeAuthError`, `ProviderRateLimitError`, `AuthTimeoutError`, `TimeoutError`, `HandoffSchemaError`, `NoProviderConfiguredError`, and more

#### @relay/cli
- `relay run <flow> [input]` — run a flow with live TTY progress display
- `relay resume <runId>` — resume a paused or crashed run from its checkpoint
- `relay runs` — list recent runs with status, flow name, and duration
- `relay logs <runId>` — tail structured logs for a run
- `relay doctor` — environment pre-flight check (node, claude binary, auth, billing)
- `relay init` — interactive provider selection writing to `~/.relay/settings.json`
- `relay new <flow-name>` — scaffold a new flow package from template
- `relay test` — run flow tests using MockProvider
- Structured exit codes (0-8) with remediation hints for every error class
- Telemetry opt-in via `~/.relay/config.json`

#### @relay/generator
- Claude Code skill that scaffolds new flow packages from a Handlebars template
