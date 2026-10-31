# Provider-native capability semantics

Mission Runtime treats provider-native options as capabilities only when the HostAdapter can observe them from a real provider contract and can make an allowed capability selection affect execution. Discovery, acquisition and delivery are separate authorities: discovering a capability does not authorize it, and durable activation does not make it usable unless the selected Host has an explicit delivery path.

## Codex app-server

Production Codex uses the stable app-server `model/list` method with `experimentalApi=false`. Discovery is bounded by timeout, page count, model count, cache TTL and single-flight execution. Discovery failure does not remove the base Codex agent capability; it only means no model/reasoning/multi-agent option is advertised for that snapshot.

For every visible model returned by the provider, Runtime creates a host-native model capability. Supported reasoning efforts become dependent reasoning capabilities. A provider `multiAgentVersion` of `v1` or `v2` becomes a dependent provider-native subagent/multi-agent capability. Hidden models are not advertised.

Capability dependencies are explicit:

- model -> `openai-codex.app-server-agent`
- reasoning effort -> owning model
- multi-agent delegation -> owning model

The capability IDs are Runtime-stable encodings of the provider model/effort identity. A Work item may receive one of those IDs through `allowedCapabilityRefs`. Before create or resume, the Codex native host wrapper resolves those refs against the current trusted discovery catalog. Stale, conflicting or operator-incompatible selections fail closed.

The selected model is passed through the existing Codex app-server worker adapter for native thread start/resume. The selected reasoning effort is applied as Codex provider configuration (`model_reasoning_effort`) when the worker process is launched. The same durable capability refs are re-resolved during cross-process resume, so recovery does not silently revert to another model/reasoning profile.

### Agent Skill delivery

GitHub Agent Skill acquisition uses the same Runtime-owned admission chain for DeepSeek and Codex: immutable revision/content-hash materialization, static security assessment, current CapabilityNeed policy and risk gates, explicit per-Mission approval, strong-isolation smoke or exact trusted-cache evidence, mission-local activation and durable capability events.

For production Codex with `capabilityAcquisition` enabled, `CapabilityWorkspaceHostAdapter` projects only the Work-authorized acquired Skill refs into the attempt workspace at the Codex repo-level path `.agents/skills/<skill-name>/SKILL.md`. The projection is rebuilt before both create and resume from the durable Mission capability overlay. Unreferenced Mission-local Skills are not copied into the Work workspace.

Codex app-server is launched with that same attempt workspace as its process cwd, and `thread/start` / `thread/resume` receive the same workspace as `cwd`. Runtime therefore uses Codex's provider-native repo Skill discovery instead of serializing Skill instructions into the model prompt or mutating a host-global Skill directory.

A custom HostAdapter still fails closed when production Agent Skill acquisition is configured. It does not inherit the Codex/DeepSeek filesystem-delivery assumption without an explicit provider-native adapter.

Production environment controls:

- `MISSION_CODEX_MODEL`: operator model constraint/default
- `MISSION_CODEX_REASONING_EFFORT`: operator reasoning-effort constraint/default
- `MISSION_CODEX_NATIVE_DISCOVERY=1|0`: enable/disable provider model discovery (default enabled)
- `MISSION_CODEX_NATIVE_DISCOVERY_TIMEOUT_MS`: bounded discovery deadline
- `MISSION_CODEX_NATIVE_DISCOVERY_CACHE_MS`: successful discovery cache TTL
- `MISSION_CODEX_NATIVE_DISCOVERY_MAX_PAGES`: pagination bound
- `MISSION_CAPABILITY_ACQUISITION=github-skills` plus `MISSION_CAPABILITY_ISOLATION=docker`: opt in to external Agent Skill acquisition

`MISSION_CODEX_NATIVE_DISCOVERY=0` preserves the base Codex agent capability and suppresses model/reasoning/multi-agent capability discovery. A Work item carrying a Codex native selection ref while discovery is disabled fails closed.

## MCP delivery

Mission has two explicit MCP trust paths and both use provider-native MCP session configuration rather than prompt-level tool emulation.

Trusted MCP is operator configured. Runtime validates the configuration at startup, exposes only non-secret capability metadata, and delivers a server only when its exact capability ref is present on the Work. Direct caller-supplied MCP declarations are rejected at the trusted delivery boundary.

External MCP is catalog discovered and Mission acquired. Admission pins immutable catalog identity, validates credential-free HTTPS delivery, treats external MCP as high risk, applies the full current CapabilityNeed resolver policy before approval, requires explicit per-Mission approval, durably records activation, and supports durable revocation tombstones. An already-active external MCP is revalidated against current revocation, maxRisk and full CapabilityNeed policy before reuse; stale or unsafe active capabilities cannot escape through a resolved fast path.

Both trusted and external MCP declarations are rebuilt for create/resume from Runtime-owned durable identity. No MCP approval or catalog record by itself grants Event Store deletion, host-global installation or arbitrary provider API access.

## Background execution

Codex app-server exposes experimental background-terminal APIs, but Mission production initialization currently declares `experimentalApi=false`. Runtime therefore does **not** advertise a stable background/job capability from those APIs. Background/job execution remains unfinished until a production HostAdapter explicitly enables and owns the provider lifecycle, recovery, cancellation and durable identity semantics.

## DeepSeek ACP

The current production DeepSeek integration uses stable ACP v1. It supports native session creation and capability-advertised `session/resume`, including reconnect after Mission process restart with the same workspace and MCP configuration. It also uses standard `session/cancel` before a bounded process-kill fallback.

ACP v1 does not define a standard mid-turn steering method. Mission therefore does not translate `steerAgent()` into a provider-private extension or pretend that a second `session/prompt` is equivalent steering. Mid-turn steering remains explicitly unsupported at this adapter boundary.

The pre-session ACP environment also does not provide Mission with an equivalent stable, provider-wide model/reasoning catalog. Runtime therefore keeps the DeepSeek ACP agent capability truthful and does not fabricate model, reasoning, subagent/team or background-job capabilities from configuration names or assumptions.

If a future ACP/provider contract exposes those semantics with durable identity and execution controls, the HostAdapter can add first-class capability nodes at that boundary.

## CLI and general-code acquisition

The domain model includes CLI, library, application and other capability kinds, but production external acquisition currently has dedicated trust/delivery profiles only for Agent Skills and external MCP.

A GitHub repository or package becoming materialized and smoke-tested is not sufficient to claim a usable CLI/general-code capability. Mission still lacks a provider-neutral per-attempt executable binding contract for PATH/environment/invocation identity and recovery across the supported Hosts. Production therefore keeps those kinds fail-closed instead of activating a directory that the Worker may not be able to invoke truthfully.

A future CLI/general-code acquisition slice must define the executable delivery authority first, then bind the generic acquisition transaction to kind-specific discovery, smoke, activation, rollback/revocation and recovery semantics.

## Failure and trust rules

- Discovery metadata is never treated as permission to execute arbitrary provider APIs.
- Model/reasoning/subagent capabilities are emitted only from validated live provider catalog data.
- Hidden or malformed catalog entries are not converted into capabilities.
- Duplicate models, invalid default reasoning efforts, unsupported multi-agent versions, repeated pagination cursors and excessive catalog size fail discovery.
- Snapshot discovery failure degrades to the base agent capability instead of fabricating stale options.
- A selected native capability requires a current catalog binding; stale IDs fail before provider work starts.
- Agent Skill delivery exposes only Work-authorized Mission-local Skills in the attempt workspace; acquisition and activation do not mutate host-global Skill directories.
- Trusted and external MCP delivery comes only from Runtime-owned registries/activation state; direct caller declarations do not bypass that authority.
- External MCP reuse is rechecked against durable revocation and the current need policy before provider work starts.
- Experimental provider APIs are not promoted into production capabilities merely because they exist.
- Capability kinds without a concrete provider-native or Runtime-owned execution/delivery contract remain unavailable rather than being represented as usable placeholders.