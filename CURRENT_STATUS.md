# Current Status

## Baseline
Architecture Freeze F0-F8 + Implementation Freeze 1.

## Implemented in the live source tree

- durable SQLite append-only Mission Event Store
- optimistic concurrency + idempotent event writes
- MissionState projection and snapshots
- MissionSpec / Acceptance / Work / Attempt / Artifact / Finding / Gap / Decision / Capability / Execution domain contracts
- scoped Context Compiler manifest
- progressive-planning provider boundary
- filesystem Workspace Manager
- versioned content-hashed Artifact Store
- LocalExecutionBackend with bounded local process execution and output commit
- execution recovery state primitive
- structural file verifier
- Capability Resolver
- Agent Skills and GitHub discovery provider interfaces
- need-driven GitHub candidate discovery/ranking
- mission-local Capability Overlay
- static capability security scanner
- policy decision layer for acquisition risk
- sandbox directory manager
- HostAdapter contract
- FakeHostAdapter
- DeepSeekHarnessAdapter boundary via injected bindings
- production DeepSeek ACP process binding over `dsh --profile acp`
- ACP initialize / session creation / prompt / update observation / one-shot permission bridge / graceful cancel / close lifecycle
- protocol-level fake ACP integration tests that do not require local DSH credentials
- event-driven MissionController boundary
- HTTP Mission API and SSE event stream
- browser-native Mission Control view
- CI workflow
- unit, integration, and E2E tests

## Next implementation frontier

Development continues toward the complete runtime, not a minimal demo. Highest-value unfinished areas are:

1. DSH session resume/reconnect and native session recovery
2. real MissionController strategy -> frontier -> dispatch -> verify -> diagnose -> replan loop
3. persistent WorkItem / Artifact / Finding / Gap projections beyond event reconstruction
4. completion challenge as an enforced pre-completion phase
5. full verifier profiles for presentations/web/video/code/research
6. GitHub/Agent Skills materialization and sandbox smoke execution
7. external capability revision pinning + provenance + activation receipts
8. approvals and side-effect manager
9. host capability graph with native semantics instead of flat availability flags
10. Reference Mission live E2E with fault injection, followed by a second host adapter

## GitHub source control

`seekpura/Mission` is the canonical remote source of truth. `main` holds the synchronized Architecture/Implementation Freeze baseline and tested runtime source. Ongoing implementation is developed from the GitHub repository and promoted through reviewed checkpoints rather than by exchanging ZIP files as the primary source.
