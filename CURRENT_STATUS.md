# Current Status

## Baseline
Architecture Freeze F0-F8 + Implementation Freeze 1.

## Implemented in the live source tree

- durable SQLite append-only Mission Event Store
- optimistic concurrency + idempotent event writes
- MissionState projection and snapshots
- MissionSpec / Acceptance / Work / Attempt / Artifact / Finding / Gap / Decision / Capability / Execution domain contracts
- event-sourced MissionJournalView for current WorkItem / Gap / decision reconstruction
- scoped Context Compiler manifest
- progressive-planning provider boundary
- runtime-driven controller strategy composition and revision
- gap diagnosis before uncovered-gap replanning
- frontier admission with graph revision, mission ownership and orphan guards
- runtime-enforced completion challenge before provider-driven mission completion
- blocking completion objections converted into blocking gaps
- mutually consistent ready/running/verifying/blocked WorkItem state projection
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
- HTTP Mission API and SSE event stream
- browser-native Mission Control view
- CI workflow
- unit, integration, and E2E tests

## Next implementation frontier

Development continues toward the complete runtime, not a minimal demo. Highest-value unfinished areas are:

1. execution dispatch from admitted WorkItems through HostAdapter / ExecutionBackend
2. artifact candidate registration and verifier scheduling after execution
3. verifier findings -> Gap -> diagnosis -> targeted repair/replan feedback loop
4. DSH session resume/reconnect and native session recovery
5. persistent WorkItem / Artifact / Finding / Gap projections beyond event reconstruction
6. full verifier profiles for presentations/web/video/code/research
7. GitHub/Agent Skills materialization and sandbox smoke execution
8. external capability revision pinning + provenance + activation receipts
9. host capability graph with native semantics instead of flat availability flags
10. Reference Mission live E2E with fault injection, followed by a second host adapter

## GitHub source control

`seekpura/Mission` is the canonical remote source of truth. `main` holds the synchronized Architecture/Implementation Freeze baseline and tested runtime source. Ongoing implementation is developed from the GitHub repository and promoted through reviewed checkpoints rather than by exchanging ZIP files as the primary source.
