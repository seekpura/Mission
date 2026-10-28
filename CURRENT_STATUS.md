# Current Status

## Baseline
Architecture Freeze F0-F8 + Implementation Freeze 1.

## Implemented in the live source tree

- durable SQLite append-only Mission Event Store
- optimistic concurrency + idempotent event writes
- MissionState projection and snapshots
- MissionSpec / Acceptance / Work / Attempt / Artifact / Finding / Gap / Decision / Capability / Execution domain contracts
- event-sourced MissionJournalView for current WorkItem / Artifact / Gap / decision reconstruction
- scoped Context Compiler manifest
- progressive-planning provider boundary
- runtime-driven controller strategy composition and revision
- gap diagnosis before uncovered-gap replanning
- frontier admission with graph revision, mission ownership and orphan guards
- host-independent WorkExecutionDriver boundary
- explicit ExecutorRouter keyed by WorkItem executor assignment, with no multi-route guessing
- ready WorkItem dispatch with attempt/execution lifecycle events
- concrete candidate Artifact registration from execution outcomes
- required-output enforcement
- independent Verifier scheduling and verification lifecycle events
- runtime validation of verifier identity/result shape before trusting verifier output
- malformed/mismatched verifier results normalized into inconclusive verification events plus blocking runtime gaps
- synthesized Findings and blocking Gaps from failed verification
- execution/verifier exceptions converted to runtime gaps
- only mission-level verification can promote an Artifact to final
- failed verification feeds the next controller cycle for diagnosis and targeted repair/replan
- runtime-enforced completion challenge before provider-driven mission completion
- blocking completion objections converted into blocking gaps
- mutually consistent ready/running/verifying/blocked WorkItem state projection
- invalidated/superseded artifacts removed from Mission final-artifact projection
- filesystem Workspace Manager
- versioned content-hashed Artifact Store
- production HostAgentWorkExecutionDriver for any HostAdapter, including DeepSeek Harness
- Mission-owned host-agent output manifest contract (`.mission-output.json`)
- host-agent hard timeout/cancel behavior and lexical + realpath/symlink workspace confinement
- manifest validation, artifact type checks, Mission-side hash/version/provenance commit
- host-agent event log capture as execution evidence
- LocalExecutionBackend with bounded local process execution and Artifact entity return
- LocalExecutionBackend output collection confined to the attempt workspace
- TrustedLocalCommandPlanner / LocalCommandWorkExecutionDriver with explicit `trusted-host-process` admission
- truthful host-level isolation metadata for local commands; local process execution is not presented as an OS sandbox
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
- unit, integration, and E2E tests including real FileArtifactStore execution/verification, host-agent artifact-contract, local routing and verifier-recovery slices

## Next implementation frontier

Development continues toward the complete runtime, not a minimal demo. Highest-value unfinished areas are:

1. GitHub / Agent Skills capability materialization, revision pinning, provenance receipt, sandbox smoke execution and mission-local activation
2. evidence-backed gap closure after repair verification, without producer self-claims
3. DSH session resume/reconnect and native session recovery
4. persistent WorkItem / Artifact / Finding / Gap projections beyond event reconstruction
5. full verifier profiles for presentations/web/video/code/research
6. host capability graph with native semantics instead of flat availability flags
7. approval and side-effect manager wired across acquisition and external actions
8. capability trust/cost/audit ledgers and activation receipts
9. Reference Mission fault-injection E2E
10. second host adapter proving HostAdapter portability

## GitHub source control

`seekpura/Mission` is the canonical remote source of truth. `main` holds the synchronized Architecture/Implementation Freeze baseline and tested runtime source. Ongoing implementation is developed from the GitHub repository and promoted through reviewed checkpoints rather than by exchanging ZIP files as the primary source.
