# Provider-native capability semantics

Mission Runtime treats provider-native options as capabilities only when the HostAdapter can observe them from a real provider contract and can make an allowed capability selection affect execution.

## Codex app-server

Production Codex uses the stable app-server `model/list` method with `experimentalApi=false`. Discovery is bounded by timeout, page count, model count, cache TTL and single-flight execution. Discovery failure does not remove the base Codex agent capability; it only means no model/reasoning/multi-agent option is advertised for that snapshot.

For every visible model returned by the provider, Runtime creates a host-native model capability. Supported reasoning efforts become dependent reasoning capabilities. A provider `multiAgentVersion` of `v1` or `v2` becomes a dependent provider-native subagent/multi-agent capability. Hidden models are not advertised.

Capability dependencies are explicit:

- model -> `openai-codex.app-server-agent`
- reasoning effort -> owning model
- multi-agent delegation -> owning model

The capability IDs are Runtime-stable encodings of the provider model/effort identity. A Work item may receive one of those IDs through `allowedCapabilityRefs`. Before create or resume, the Codex native host wrapper resolves those refs against the current trusted discovery catalog. Stale, conflicting or operator-incompatible selections fail closed.

The selected model is passed through the existing Codex app-server worker adapter for native thread start/resume. The selected reasoning effort is applied as Codex provider configuration (`model_reasoning_effort`) when the worker process is launched. The same durable capability refs are re-resolved during cross-process resume, so recovery does not silently revert to another model/reasoning profile.

Production environment controls:

- `MISSION_CODEX_MODEL`: operator model constraint/default
- `MISSION_CODEX_REASONING_EFFORT`: operator reasoning-effort constraint/default
- `MISSION_CODEX_NATIVE_DISCOVERY=1|0`: enable/disable provider model discovery (default enabled)
- `MISSION_CODEX_NATIVE_DISCOVERY_TIMEOUT_MS`: bounded discovery deadline
- `MISSION_CODEX_NATIVE_DISCOVERY_CACHE_MS`: successful discovery cache TTL
- `MISSION_CODEX_NATIVE_DISCOVERY_MAX_PAGES`: pagination bound

`MISSION_CODEX_NATIVE_DISCOVERY=0` preserves the base Codex agent capability and suppresses model/reasoning/multi-agent capability discovery. A Work item carrying a Codex native selection ref while discovery is disabled fails closed.

## Background execution

Codex app-server exposes experimental background-terminal APIs, but Mission production initialization currently declares `experimentalApi=false`. Runtime therefore does **not** advertise a stable background/job capability from those APIs. Background/job execution remains unfinished until a production HostAdapter explicitly enables and owns the provider lifecycle, recovery, cancellation and durable identity semantics.

## DeepSeek ACP

The current production DeepSeek integration uses stable ACP v1. Its pre-session environment does not provide Mission with an equivalent stable, provider-wide model/reasoning catalog. Runtime therefore keeps the DeepSeek ACP agent capability truthful and does not fabricate model, reasoning, subagent/team or background-job capabilities from configuration names or assumptions.

If a future ACP/provider contract exposes those semantics with durable identity and execution controls, the HostAdapter can add first-class capability nodes at that boundary.

## Failure and trust rules

- Discovery metadata is never treated as permission to execute arbitrary provider APIs.
- Model/reasoning/subagent capabilities are emitted only from validated live provider catalog data.
- Hidden or malformed catalog entries are not converted into capabilities.
- Duplicate models, invalid default reasoning efforts, unsupported multi-agent versions, repeated pagination cursors and excessive catalog size fail discovery.
- Snapshot discovery failure degrades to the base agent capability instead of fabricating stale options.
- A selected native capability requires a current catalog binding; stale IDs fail before provider work starts.
- Provider-native discovery does not enable arbitrary `invokeHostCapability`, trusted MCP projection, Agent Skill delivery or experimental background APIs.
