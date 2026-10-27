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
- event-driven MissionController boundary
- HTTP Mission API and SSE event stream
- browser-native Mission Control view
- CI workflow
- unit, integration, and E2E tests

## Next implementation frontier

Development continues toward the complete runtime, not a minimal demo. Highest-value unfinished areas are:

1. real DSH binding implementation against the installed harness API
2. persistent WorkItem / Artifact / Finding / Gap projections beyond event reconstruction
3. actual Strategy / Frontier / Gap diagnosis model provider
4. full verifier profiles for presentations/web/video/code/research
5. GitHub/Agent Skills materialization and sandbox smoke execution
6. external capability revision pinning + acquisition receipts
7. process cancellation tree + stronger recovery
8. approvals and side-effect manager
9. capability trust/cost/audit ledgers
10. Reference Mission live E2E with fault injection

## GitHub source control

A local Git repository is maintained as the source baseline. The connected GitHub app has read/write access to existing repositories but does not expose a create-repository action in this environment. Existing user repositories are not repurposed without explicit intent. Once a dedicated remote repository exists or the connector exposes repository creation, the local history can be pushed without re-baselining.
