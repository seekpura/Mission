# Mission Runtime — Current Status

## Canonical baseline

Architecture Freeze F0–F8 + Implementation Freeze 1 remain the governing architecture.

`seekpura/Mission` is the canonical source of truth.

- `main`: stable checkpoints
- `develop`: active complete-runtime development
- ZIP/bundle exports: recovery artifacts only

Latest functional checkpoint before this status update:

`3e64c49b3df25dea9e2d0220749392d1be221303` — `feat: persist governance cost audit trust and completion ledgers`

All new work must continue from current `develop`; do not reconstruct from old ZIPs, chat snippets, or historical branches.

## System identity

Mission is a host-independent **Mission Control Plane + Adaptive Execution Plane**.

Core owns Goal / Acceptance / durable state / Strategy / progressive planning / Decisions / Gaps / Verification / Completion / Capability resolution / governance.

Host adapters expose Agents / Skills / MCP / Tools / Browser / Shell / Applications / permissions and execution surfaces.

DeepSeek Harness is the first Reference Host, not a permanent core dependency.

Principle: **Agent is disposable; Mission is durable.**

## Implemented and live on `develop`

### Durable Mission control plane

- SQLite append-only Mission Event Store
- optimistic concurrency and idempotent event writes
- event + projection atomic persistence
- durable MissionState / MissionSpec / AcceptanceContract / Requirement / Work / Attempt / Execution / Artifact / Evidence / Finding / Gap / Decision / Approval projections
- snapshots and projection rebuild
- event-driven MissionController
- hard Acceptance matrix and deterministic completion gate
- independent Completion Challenger
- Strategy Composer + rolling Frontier Planner
- progressive WorkItem creation rather than fixed up-front DAG
- canonical Gap diagnosis and repair work creation

### Dynamic repair and progress control

- Finding normalization and conservative canonical Gap clustering
- Gap reopen on recurrence
- RootCauseDiagnosis with competing hypotheses, confidence and Evidence
- minimum sufficient repair ladder:
  `attempt -> work_item -> executor -> capability -> graph -> strategy`
- real `replace_executor` enactment
- real `replace_capability` enactment and replacement CapabilityNeed
- repeated-repair IDs and escalation
- meaningful progress signatures
- WAITING vs STALLED vs truthful PLATEAU
- deterministic stalled-progress repair floor: repeated stagnation cannot keep retrying below the next repair scope

### User steering

- operational vs semantic steering
- MissionSpec and AcceptanceContract revision
- affected-scope analysis
- selective Work invalidation
- selective Artifact-lineage invalidation
- cancel only affected active executions
- stale worker result cannot overwrite invalidated work
- unrelated branches continue
- completed Mission can reopen after semantic steering

### Execution plane

- filesystem Workspace Manager
- immutable/versioned/content-hashed Artifact Store
- Artifact write leases
- Resource Manager and bounded concurrency
- LocalExecutionBackend
- HostAgentExecutionBackend
- HostCapabilityExecutionBackend
- dynamic WorkExecutionRouter
- direct host Tool/MCP invocation where contract is explicit
- structured mission-local CLI invocation
- Host Agent fallback for composed/multi-capability work
- side-effect policy and approval boundary
- InvocationReceipt with route/executor/side effects/approval references
- cancellation ownership and lease release

### Recovery

- execution LOST reconciliation
- Recovery by Observation before retry
- execution recovery manifest
- worker recovery envelope
- recovered Artifact validation/commit
- no blind retry when output or uncertain side effects may already exist

### Capability system

- durable CapabilityNeed / Candidate / AcquisitionReceipt
- host capability resolution
- Agent Skills CLI discovery
- GitHub REST discovery
- candidate ranking
- exact Git commit pinning
- quarantine and content hash
- static security scanning
- acquisition policy
- sandbox smoke execution
- mission-local immutable activation
- mission-local Capability Overlay
- precise Skill selection in multi-Skill repositories
- missing capability becomes visible Acquisition Work
- original Work unlocks only after capability is actually available
- verification capabilities can self-heal through the same acquisition path

### Verification and Artifact assurance

- typed VerificationProfile / VerificationPlanner / VerifierRegistry
- deterministic structural checks
- structured runtime command checks
- integration checks
- independent host perceptual review
- unsupported required checks remain INCONCLUSIVE
- Artifact promotion blocked by missing required assurance
- derived inspection Artifacts for presentation/web/video-style perceptual checks
- inspection lineage and workspace containment
- missing renderer/screenshot/keyframe capability -> CapabilityNeed -> secure acquisition -> Verification continuation
- production Artifact is not regenerated merely because QA tooling was missing
- durable per-check Verification cache
- targeted re-verification
- runtime/human checks are not incorrectly frozen in cache

### Source / Truth / freshness / knowledge continuity

- durable SourceRecord and TruthRecord
- independent SQLite knowledge projector
- Worker sources + proposedFacts ingestion
- sourced facts become verified Truth; unsourced facts remain assumed/inference
- Source `freshUntil` scanning
- Source stale/unavailable propagation:
  Source -> Truth -> Evidence -> Artifact -> Requirement -> Gap
- completed Mission reopens when accepted evidence becomes stale
- stale Source/Truth excluded from active Worker context
- relevant active Truth/Source selected by Requirement/input Artifact scope
- stale knowledge is exposed separately as repair diagnostics, never as active authority
- explicit Source replacement lineage (`replacesSourceRef`)
- explicit Truth replacement lineage (`supersedesTruthRef`)
- replacement Truth must be active, sourced and verified
- stale-source repair E2E closes only after refreshed Artifact verification and Gap resolution
- freshness scan runs before Mission control/completion cycles

### Governance / observability read models

- durable Invocation receipts
- Approval and side-effect audit foundation
- CostEvent projection from actually observed wall time and external side-effect count
- AuditRecord projection for approvals, capability lifecycle, external side effects and completion
- contextual CapabilityTrustProfile per Mission / capability / Work purpose
- trust tracks real attempts, success/failure/cancel and observed average wall time
- CompletionRecord frozen at `mission.completed` with requirement coverage, final Artifacts, blocking gaps, verification count and observed wall time
- governance projections rebuild from Event Store
- no invented token, compute or monetary cost when the host did not expose it

### DeepSeek Harness reference host

Pinned implementation reference:

`deepseek-ai/deepseek-harness@22ddee3792402c3e70ec5f86a63c3e3e895a2f60`

Implemented:

- host-independent HostAdapter
- DeepSeekHarnessAdapter
- official public Agent create/followup/steer/cancel/whenIdle binding
- host capability snapshot from tool schemas
- host tool invocation
- disposable Host agents for Mission deliberation
- loadable DSH plugin under `integrations/deepseek-plugin/`
- `mission_start`
- `mission_status`
- `mission_steer`
- temporary operator/debug `mission_cycle`

## Verification discipline

Every substantial feature batch is developed on an isolated `build/*` branch and is required to pass:

1. full repository `npm test`
2. `npm run smoke`
3. `git diff --check`
4. feature-specific integration/E2E assertions

Only the verified functional tree is squashed into a clean single commit on `develop`; temporary patch scripts, diagnostic logs and build workflows are excluded.

Recent E2E coverage includes:

- autonomous Goal -> Artifact -> Evidence -> Completion
- missing capability acquisition and unlock
- self-healing verification capability acquisition
- cancellation and lease release
- runtime restart / LOST / recovery by observation
- direct tool routing vs Agent routing
- Finding clustering and repair targeting
- executor/capability replacement
- user semantic steering with selective invalidation
- truthful plateau and deterministic repair escalation
- stale evidence invalidation
- source refresh and Truth rebinding
- freshness-before-completion gate
- governance ledger rebuild

## Highest-value remaining work

The following are still meaningful unfinished product work; do not re-implement the completed subsystems above.

1. **Budget enforcement**
   - Mission / Workstream / Work / Attempt budgets
   - hard vs advisory limits
   - observed wall-time / attempts / acquisitions / side-effect limits first
   - token / monetary limits only when the host exposes trustworthy usage data
   - BUDGET_EXHAUSTED or approval/escalation behavior

2. **Cross-mission experience and trust promotion**
   - current trust is Mission-scoped
   - add exact-revision, task/purpose-aware reusable priors
   - sample-size aware
   - no historical prior may override current Mission constraints
   - revalidation/decay for stale capability revisions

3. **Governance/API/Mission Control surfaces**
   - expose Cost / Audit / Trust / Completion views
   - keep user-facing UI Mission-semantic, not raw observability spam

4. **DSH-native Mission Control product surface**
   - richer interactive Mission view beyond callable tools
   - approvals, blockers, gaps, Artifacts, current strategy and completion evidence

5. **Reference Mission live E2E on real DSH**
   - latest-source research
   - missing motion/inspection capability
   - first candidate functional failure
   - mid-Mission style/content steering
   - Artifact visual defect
   - stale source
   - playback/integration defect
   - runtime restart and recovery
   - final Completion Challenger

6. **Additional host adapters / durable distributed backend**
   - only after the DSH live Reference Mission is robust
   - preserve HostAdapter / ExecutionBackend boundaries
   - do not introduce Temporal/Kubernetes as V0.1 core dependencies

## Immediate development frontier

Continue from current `develop` with **Budget Enforcement**, then expose the new governance read models through API/Mission Control, then run the full real-DSH Reference Mission fault-injection campaign.
