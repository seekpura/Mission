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
- durable ExecutionRuntimeBinding with execution / attempt / work / driver / route / host-handle / native-session / workspace identity
- execution.bound and execution.recovery.started event semantics
- restart recovery is attempted before replanning for active executions
- same-process execution ownership prevents duplicate reconnect attempts
- recovered execution outcomes use the same Artifact / required-output / Verifier / Gap / Attempt / Work settlement path as normal execution
- unrecoverable or unbound active executions become lost + blocking runtime gaps instead of remaining stuck
- concrete candidate Artifact registration from execution outcomes
- required-output enforcement
- independent Verifier scheduling and verification lifecycle events
- runtime validation of verifier identity/result shape before trusting verifier output
- malformed/mismatched verifier results normalized into inconclusive verification events plus blocking runtime gaps
- verifier gap-assessment protocol (`resolved` / `still_open` / `inconclusive`)
- gaps close only from explicit passing independent-verifier evidence; producer self-claims cannot close gaps
- conflicting or absent gap evidence leaves the gap open
- synthesized Findings and blocking Gaps from failed verification
- execution/verifier exceptions converted to runtime gaps
- only mission-level verification can promote an Artifact to final
- failed verification feeds the next controller cycle for diagnosis and targeted repair/replan
- runtime-enforced completion challenge before provider-driven mission completion
- blocking completion objections converted into blocking gaps
- mutually consistent ready/running/verifying/blocked WorkItem state projection
- invalidated/superseded artifacts removed from Mission final-artifact projection
- filesystem Workspace Manager with recovery-only reopen semantics
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
- structural file verifier
- Capability Resolver
- Agent Skills and GitHub discovery provider interfaces
- need-driven GitHub candidate discovery/ranking
- mission-local Capability Overlay with restart restoration from durable capability activation events
- concrete CapabilityNeed entities admitted before dependent WorkItems
- automatic capability ensure/acquisition before attempt creation
- acquired capability refs injected into ContextPacket and attempt execution
- missing/unresolved capability needs block Work before execution and open capability gaps
- static capability security scanner
- policy decision layer for acquisition risk
- capability acquisition enforces CapabilityNeed.maxRisk
- repository capability materialization with immutable revision pinning and deterministic SHA-256 tree hash
- materialized-repository symlink containment checks
- restricted/container/vm/remote-only external-code smoke admission; host/process execution is rejected as insufficient isolation
- high-risk acquisition approval boundary
- durable immutable acquisition receipts for rejection / approval / smoke / activation outcomes
- mission-local capability activation without mutating host-global capability directories
- HostAdapter contract
- FakeHostAdapter
- DeepSeekHarnessAdapter boundary via injected bindings
- production DeepSeek ACP process binding over `dsh --profile acp`
- ACP initialize / session creation / prompt / update observation / one-shot permission bridge / graceful cancel / close lifecycle
- ACP v1 session/resume with capability negotiation on a fresh DSH process and fresh ACP connection
- preserved Mission host-handle identity and native ACP session identity across reconnect
- recovery continuation prompt that inspects existing workspace and warns against blindly repeating irreversible side effects
- exact executor-route recovery even when multiple routes share the same underlying driver id
- protocol-level fake ACP integration tests including cross-process native-session resume without local DSH credentials
- HTTP Mission API and SSE event stream
- browser-native Mission Control view
- CI workflow
- unit, integration, and E2E tests including real FileArtifactStore execution/verification, host-agent artifact-contract, trusted local routing, verifier recovery, acquisition transaction, capability runtime loop, evidence-backed gap closure, controller replacement recovery and cross-process ACP resume

## Next implementation frontier

Development continues toward the complete runtime, not a minimal demo. Highest-value unfinished areas are:

1. production runtime composition/bootstrap so the server actually wires planner, executor routes, verifier profiles, capability runtime and HostAdapters instead of exposing only the core controller shell
2. persistent WorkItem / Artifact / Finding / Gap read-model projections beyond event reconstruction
3. full verifier profiles for presentations / web / video / code / research and profile selection
4. host capability graph with native semantics, constraints and routing characteristics instead of flat availability flags
5. approval and side-effect manager wired consistently across acquisition, host permissions and external actions
6. concrete GitHub / Agent Skills repository transport for production capability materialization plus trusted-cache reuse policy
7. capability trust / cost / audit ledgers and activation lifecycle management
8. Reference Mission fault-injection E2E covering process death, lost session, verifier faults, capability acquisition failure and repair/replan
9. second production host adapter proving HostAdapter portability
10. production typecheck / schema compatibility gate in CI in addition to Node strip-types runtime tests

## GitHub source control

`seekpura/Mission` is the canonical remote source of truth. `main` holds the synchronized Architecture/Implementation Freeze baseline and tested runtime source. Ongoing implementation is developed from the GitHub repository and promoted through reviewed checkpoints rather than by exchanging ZIP files as the primary source.
