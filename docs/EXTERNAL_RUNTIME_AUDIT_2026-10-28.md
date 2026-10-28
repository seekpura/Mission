# External Runtime Audit — 2026-10-28

## Purpose

This audit compares Mission Runtime against current public agent orchestration, harness, task-state, skill-discovery, and plugin-management implementations. It is used to protect Mission's architectural boundary from accidental duplication and to choose the next implementation frontier.

## Mission boundary remains valid

Mission Runtime remains a host-independent control plane. It owns mission state, acceptance, planning, orchestration, artifact/evidence/gap handling, verification, capability resolution/acquisition policy, recovery, and completion. Host harnesses own native agents, models, tools, skills, MCP servers, credentials, sandboxes, browser/shell/application capabilities, and native session execution.

The external audit does not justify replacing this boundary with a harness-specific orchestrator.

## Audited projects

### Intelligent-Internet/zenith

Useful mechanisms:

- long-running mission loop focused on premature-completion prevention;
- one orchestrator repeatedly reopens current state and decides worker, validator, skill, replan, or stop;
- explicit contract-first planning and independent validation;
- attention/replan handling that traces failures back to the earliest invalid artifact rather than blindly retrying the current symptom;
- separate worker and validator roles over ACP providers.

Adopt the control ideas, not Zenith's prompt-owned mission model or provider-specific installation shape.

### awslabs/cli-agent-orchestrator (CAO)

Useful mechanisms:

- provider-neutral supervisor/worker control plane;
- provider adapters separated from terminal/session backends;
- SQLite-backed sessions, events, inboxes, workflows, memory, decisions, and plugins;
- explicit tool restrictions and fail-closed plugin-server allowlists;
- Agent Plugins 1.0.0 source validation, source-host restrictions, staged installation, projection, rollback, and lifecycle handling;
- separate operator/control surfaces from provider-native CLIs.

Important limitation for Mission: CAO explicitly states that it has no cryptographic trust/signing/provenance model for third-party agent plugins. Mission must go further because external capability acquisition is a first-class runtime responsibility.

### OrchestratorInc/agent-orchestrator (AO)

Useful mechanisms:

- broad harness adapters and isolated worktree/session ownership;
- CI/review feedback routed back to the owning worker;
- DeepSeek Harness integration over the harness's standard ACP profile rather than internal imports.

DeepSeek-specific finding:

- launch `dsh --profile acp` for the complete chat/control path;
- use ACP session/new and session/resume;
- carry standing instructions on the first turn because DSH session/new receives working-directory state rather than a separate standing system prompt;
- answer `session/request_permission` per request while leaving DSH's own permission/sandbox policy authoritative;
- treat model values as opaque catalog values supplied by the DSH session;
- use `dsh --profile headless <task>` only for one-shot execution surfaces.

This confirms Mission's current rule: core must not import DSH internals. A real DSH binding belongs entirely behind HostAdapter.

### deepseek-ai/deepseek-harness

Useful mechanisms:

- everything-is-a-plugin composition over Cordis;
- replaceable model, tool, session, agent-loop, filesystem, subprocess, sandbox, approval, job, webhook, and subagent seams;
- durable session/event log as the source of model-visible history;
- plugin/profile/bundle composition and reversible effects;
- explicit subagent and experimental agent-team capability seams;
- plugin management guarded by DSH approval/sandbox rules.

Mission should consume these capabilities through the host boundary rather than recreate them.

### jpicklyk/task-orchestrator

Useful mechanisms:

- server-enforced work-state transitions and quality gates;
- persistent dependency graph;
- required phase notes/traits and actor attribution;
- session continuity from compact state/context reads rather than conversation reconstruction.

Mission should adopt the enforcement principle but preserve its own event-sourced mission model. Gates that determine Mission truth must be runtime-enforced, not prompt-only.

### GetSkill-Agent/getskill-mcp

Useful mechanisms:

- need-time skill discovery;
- small metadata index with full SKILL.md fetched only on demand;
- skill packs as reusable compositions.

Mission should treat this as a discovery-source pattern, not as a trust or activation layer. Retrieval is not equivalent to safe acquisition.

### wshobson/agents

Useful mechanisms:

- one canonical component source adapted into multiple harness-native formats;
- explicit harness capability matrix rather than lowest-common-denominator conversion;
- generation/validation of provider-specific artifacts.

Mission should use the same principle for host adapters and capability materialization: retain a canonical capability descriptor, then adapt delivery to the target host's actual semantics.

## What Mission already has that should be preserved

The current repository already contains the correct high-level separation:

- append-only mission events and snapshots;
- MissionState projection;
- MissionSpec / Acceptance / Work / Artifact / Finding / Gap / Decision / Capability / Execution contracts;
- HostAdapter boundary;
- ExecutionBackend boundary;
- mission-local capability overlay;
- capability discovery/ranking/inspection/policy interfaces;
- artifact store and verifier boundary;
- DeliberationProvider contract with strategy, frontier planning, gap diagnosis, and completion challenge.

These are not replaced by any audited project.

## Current implementation gaps exposed by the audit

### P0 — Controller loop is not yet a real mission loop

`MissionController.runControllerCycle()` currently projects state and checks a deterministic completion gate, but it does not yet drive strategy -> frontier -> execution -> verification -> gap diagnosis -> repair/replan -> completion challenge.

The default deterministic deliberation implementation also returns an empty frontier and an always-pass completion challenge. Until this is replaced, Mission cannot demonstrate its core distinction from ordinary orchestrators.

### P0 — DeepSeek Harness adapter is only a boundary scaffold

The current DeepSeekHarnessAdapter delegates to injected bindings, but no production binding launches or drives DSH.

The first real binding should prefer standard ACP over DSH internals:

1. resolve the `dsh` binary;
2. launch `dsh --profile acp` as a child process;
3. establish ACP stdio transport;
4. initialize/create or resume a native DSH session;
5. translate Mission AgentCreateRequest into the first-turn context and capability restrictions;
6. translate ACP session updates/tool events into HostAgentEvent;
7. translate Mission approval decisions into ACP permission replies while keeping DSH's own policy authoritative;
8. persist native session ids for recovery;
9. implement cancellation and observation/reconnect semantics;
10. keep DSH package types and implementation details out of Mission core.

### P0 — Capability acquisition needs provenance, pinning, and activation receipts

The current static scanner is a useful first filter, but it is regex-based and does not establish provenance or safe execution.

The next acquisition pipeline should add:

- immutable source revision resolution before inspection;
- source host/protocol allowlist;
- manifest and package-shape validation;
- recursive path/symlink/special-file containment checks;
- install/build-hook extraction before execution;
- requested permission/tool/network/process footprint extraction;
- staged materialization into a mission-local quarantine directory;
- sandbox smoke execution where applicable;
- explicit approval for high-risk build/install hooks;
- activation receipt containing source URI, resolved revision, content digest, inspection report, policy decision, granted scope, host target, activation path, and rollback handle;
- default-inert delivery: acquired MCP/tools do not silently widen any agent's allowed capability set.

### P1 — Work/verification gates should be runtime-enforced

Use Task Orchestrator's principle without adopting its schema model wholesale:

- WorkItems transition only through controller-owned operations;
- dependency and prerequisite state is checked by runtime before dispatch;
- verification evidence is required before artifact promotion;
- a blocking Finding creates/maintains a Gap;
- unresolved blocking Gaps prevent completion;
- producer completion claims never move the mission to completed.

### P1 — Host capability catalog needs native semantics

EnvironmentSnapshot currently exposes a flat capability list plus shell/filesystem/browser booleans. It should evolve into a host capability graph that can represent:

- agent/session creation and resume;
- model and reasoning options;
- skills and skill install/load modes;
- MCP/tool delivery;
- approval modes;
- filesystem/shell/browser/job/background execution;
- subagents/team support;
- persistence/resume/recovery features;
- isolation/sandbox guarantees;
- capability provenance and native identifiers.

This keeps Mission from assuming that different harnesses implement the same named feature identically.

## Revised implementation order

The next work should follow one continuous vertical slice rather than independent feature buckets.

1. **Real DSH ACP binding** — create/resume/observe/cancel/permission round trip against a real `dsh --profile acp` process.
2. **Controller orchestration loop** — wire DeliberationProvider into state-driven decisions and frontier dispatch.
3. **Execution/verification feedback loop** — candidate artifact -> verifier -> Finding -> Gap -> diagnosis -> repair/replan.
4. **Completion challenge** — a separate challenge pass must run before mission.completed can be emitted.
5. **Capability acquisition receipts** — immutable revision, provenance, staged inspection, policy, sandbox smoke, mission-local activation, rollback.
6. **Host capability graph** — replace flat environment assumptions with native feature semantics.
7. **Reference Mission fault-injection E2E** — prove recovery from worker failure, invalid artifact, missing capability, rejected capability, approval pause, verifier failure, stale session, and restart.
8. **Second host adapter** — only after the DSH vertical slice passes; use another ACP/native host to prove the core is truly host-independent.

## Non-goals

Do not:

- turn Mission into another coding-agent worktree manager;
- make DSH a core dependency;
- duplicate DSH's model/tool/session/sandbox internals;
- make acquired plugins globally active by default;
- use prompt instructions as the sole enforcement of acceptance, verification, or completion;
- hard-code artifact-type workflows or permanent agent teams into core;
- claim capability trust based only on GitHub popularity, repository name, or a static regex scan.

## Decision

Architecture Freeze F0-F8 and Implementation Freeze 1 remain valid.

The audit changes implementation priority, not architecture: stop expanding abstractions and complete the first real end-to-end control loop, beginning with a production DSH ACP binding and runtime-driven plan/dispatch/verify/replan/complete behavior.
