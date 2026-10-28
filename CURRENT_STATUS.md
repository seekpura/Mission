# Current Status

## Baseline
Architecture Freeze F0-F8 + Implementation Freeze 1.

## Implemented in the live source tree

- durable SQLite append-only Mission Event Store
- optimistic concurrency + idempotent event writes
- MissionState projection and snapshots
- transactional durable read-model projections for Mission / WorkItem / Attempt / Execution / Artifact / Finding / Gap / Decision / Approval / CapabilityNeed / Capability
- read-model projection and event append share one SQLite transaction; projection failure rolls back the event write
- read-model catch-up can reconstruct current views from the append-only event log after projection loss
- Mission-scoped read-model identity prevents cross-Mission collisions for local entity ids
- `SqliteMissionReader` provides current Mission state, journal entities and latest strategy without full history replay on normal runtime paths
- production bootstrap shares the durable reader across controller, host planner and independent verifier
- MissionSpec / Acceptance / Work / Attempt / Artifact / Finding / Gap / Decision / Capability / Execution domain contracts
- event-sourced MissionJournalView retained as the recovery/fallback reconstruction path
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
- artifact-specific verifier profile registry for presentation / website / video / code / research plus generic fallback
- deterministic verifier-profile selection by explicit artifact type, then MIME type, then extension, then generic fallback
- verifier profiles define required checks, evidence expectations, artifact-specific review instructions and bounded inline-content budgets
- required verifier-profile checks fail closed: omitted checks become inconclusive and duplicate required checks are rejected
- selected verification profile id is persisted on VerificationResult
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
- first-class semantic host capability graph foundation with capability / environment / executor-route nodes and dependency / environment / routing edges
- CapabilityDescriptor semantic contracts for explicit functions, logical inputs/outputs, purpose/environment/dependency constraints, permissions, routing/isolation, cost/latency, provider-native semantics and provenance
- EnvironmentSnapshot can publish a semantic `capabilityGraph` while legacy host adapters remain compatible with the flat capability list
- graph-aware capability resolution hard-gates unsupported purpose, unavailable/unknown required environments and unavailable capability dependencies before semantic ranking
- resolver prefers explicit function and I/O semantics over name/description coincidence, includes permissions/cost/routing in deterministic selection, and remains backward-compatible with legacy flat descriptors
- host and acquisition-enabled capability runtimes resolve against live environment semantics rather than flat availability flags
- DeepSeek Harness ACP capability publishes protocol/native identity, session/resume/recovery behavior, approval semantics, routing/isolation, cost class and host provenance into the graph
- frontier planning and capability-gap diagnosis receive a live graph combining current host capabilities with durable mission-local activated capabilities, so CapabilityNeeds are created against observed capability semantics rather than names alone
- outer Host delivery wrappers rebuild the semantic graph from the final effective capability catalog, preventing stale graphs when inner adapters such as trusted MCP delivery extend the host catalog
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
- production GitHub REST Agent Skill discovery and immutable commit/blob materialization without `git clone`, archive extraction or repository code execution
- GitHub capability transport rejects truncated trees, submodules, unsupported Git modes, unsafe paths, oversized snapshots/blob mismatches and non-canonical repository URLs
- partial failed capability snapshots are removed from quarantine staging
- production Agent Skill acquisition is opt-in and requires Docker strong isolation; weak isolation or unknown acquisition modes fail closed
- Docker capability smoke runs with no network, read-only candidate/root filesystem, dropped capabilities, no-new-privileges, non-root UID/GID and bounded resources, with image pulling disabled
- Agent Skill acquisition requires exactly one DSH-compatible `SKILL.md`, validates required YAML frontmatter / kebab-case name / model-invocable semantics, and does not execute third-party install/build/test scripts
- every external Agent Skill requires explicit durable user approval even after low-risk static scanning because the Skill is behavioral instruction supply-chain content
- only the validated Agent Skill bundle is activated mission-locally; unrelated repository files outside the bundle are not promoted into the runtime capability store
- activated Agent Skill bundles are revalidated for file/byte limits and symlink containment at activation and Work delivery time
- Work-authorized Agent Skills are projected into the attempt-local `.agents/skills/<skill-name>/` tree and loaded through DeepSeek Harness's native filesystem skill catalog/tool rather than copied into the model prompt
- resume/reconnect rebuilds the same Work-scoped Agent Skill projection from durable capability refs; unreferenced mission-local Skills are not exposed to the Worker
- `.mission-skill-projection.json` records the concrete per-attempt capability-to-workspace projection
- planner/verifier/control sessions do not inherit acquired Skills implicitly; non-Skill mission-local capability kinds remain fail-closed until a dedicated provider-native delivery adapter exists
- trusted operator-configured MCP servers are exposed as host capabilities and delivered only when explicitly present in a WorkItem's allowed capability refs
- trusted MCP supports ACP `session/new` and `session/resume` through provider-native `mcpServers` for both stdio and HTTP transports
- trusted MCP configuration validates safe IDs/names/revisions, absolute stdio commands, header/env shapes and HTTPS-by-default HTTP endpoints; runtime secret values remain in memory rather than durable projection receipts
- `.mission-mcp-projection.json` records only non-secret Work-scoped MCP capability/revision/config-shape metadata and recovery fails closed if the configured revision or shape changes
- direct caller-supplied MCP declarations are rejected at the trusted delivery boundary, so only the runtime-owned registry can populate provider-native MCP sessions
- externally discovered/acquired MCP, CLI and general code capabilities remain unsupported and fail-closed until dedicated acquisition, trust, isolation and rollback profiles exist
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
- production runtime bootstrap composing SQLite/EventStore/read models, DSH HostAdapter, trusted MCP delivery, host planner, ExecutorRouter, host worker driver, independent verifier, capability runtime, supervisor and approvals
- strict framed-JSON HostAgent control transport for planner/verifier calls; malformed or unframed model output is rejected
- HostDeliberationProvider uses fresh host sessions while reconstructing current user goal, latest strategy, capability needs, activated capabilities, WorkItems, Artifacts and open Gaps from the durable reader when available
- planner output cannot set Mission identity, Work status, graph ownership, timestamps, creator or unknown executor routes
- HostArtifactVerifier performs deterministic file/hash checks before a separate profile-selected mission-level host review
- per-Mission single-flight MissionSupervisor automatically drives controller cycles after create / steering / approval / restart events
- SQLite Mission catalog discovers persisted missions for startup recovery
- RuntimeApprovalManager persists approval request/decision events before host release, rejects stale restart approvals, and makes the first durable decision authoritative under concurrent operators
- current host permission bridge exposes only truthful one-shot approval scope
- HTTP Mission API now wakes the supervisor automatically, exposes approval list/decision/manual-wake endpoints, and streams supervisor updates over SSE
- production server startup resumes non-terminal persisted Missions instead of exposing a passive controller shell
- HTTP Mission API and SSE event stream
- browser-native Mission Control view
- CI workflow
- unit, integration, and E2E tests including real FileArtifactStore execution/verification, host-agent artifact-contract, trusted local routing, verifier recovery, verifier-profile routing/fail-closed coverage, semantic capability graph/planner routing, trusted MCP graph consistency and ACP create/resume delivery, acquisition transaction, capability runtime loop, production Agent Skill acquisition/native DSH delivery, GitHub snapshot security, Docker isolation flags, evidence-backed gap closure, controller replacement recovery, cross-process ACP resume, production bootstrap, restart continuation, durable planner/verifier continuity and approval concurrency

## Next implementation frontier

Development continues toward the complete runtime, not a minimal demo. Highest-value unfinished areas are:

1. side-effect manager wired consistently across external actions, idempotency, irreversible-operation policy and approval boundaries
2. capability trust / cost / audit ledgers, trusted-cache reuse and activation lifecycle management
3. profile-specific verifier evidence collectors/adapters for rendered presentations, browser/runtime web checks, media probe/playback evidence, executable code/test evidence and research-source traceability; profiles now define the obligations but do not fabricate missing inspection evidence
4. Reference Mission fault-injection E2E covering process death, lost session, verifier faults, capability acquisition failure and repair/replan
5. second production host adapter proving HostAdapter portability
6. production typecheck / schema compatibility gate in CI in addition to Node strip-types runtime tests
7. graceful process shutdown / drain semantics for in-flight supervisor cycles and host sessions
8. extend provider-native capability graph coverage for model/reasoning options, subagents/team semantics and background/job execution as host adapters expose them
9. external MCP discovery/acquisition plus provider-native CLI/general-code delivery with explicit trust, isolation, approval and rollback profiles
10. operational read-model/query APIs and observability for long-lived high-volume Missions beyond the current runtime-facing reader

## GitHub source control

`seekpura/Mission` is the canonical remote source of truth. `main` holds the synchronized Architecture/Implementation Freeze baseline and tested runtime source. Ongoing implementation is developed from the GitHub repository and promoted through reviewed checkpoints rather than by exchanging ZIP files as the primary source.
