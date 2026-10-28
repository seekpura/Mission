# DeepSeek Harness Adapter Boundary

DeepSeek Harness is the first reference host, not a dependency of Mission Core.

The adapter is responsible for:

- host/environment description
- installed skill/tool/agent capability discovery
- agent create / observe / steer / cancel
- host-native capability invocation
- permission / approval bridge
- host event normalization

The adapter must not own:

- mission strategy
- mission planning
- gap analysis
- capability discovery policy
- artifact finalization
- mission completion

`src/hosts/deepseek/deepseek-host-adapter.ts` defines the compile-time boundary. Concrete DSH runtime bindings are injected through `DeepSeekBindings`, so DSH package details do not leak into core.

## Production ACP binding

`src/hosts/deepseek/acp-process-bindings.ts` is the first concrete binding.

It uses the standard ACP v1 automation surface rather than importing DeepSeek Harness internals:

- launches `dsh --profile acp` as a child process;
- communicates over newline-delimited JSON on stdio with `@agentclientprotocol/sdk@1.4.0`;
- initializes the ACP connection and creates a native DSH session rooted at the Mission workspace;
- sends the compiled Mission work context as the first prompt;
- normalizes ACP session updates into `HostAgentEvent` values;
- bridges `session/request_permission` to a Mission approval handler and selects only advertised one-shot allow/reject options;
- requests protocol cancellation first, then uses a bounded process-kill fallback;
- closes the ACP session/connection and reaps the child process when a turn terminates.

The binding does not grant permissions up front and does not bypass DSH sandbox or approval policy. The host remains authoritative for native tool restrictions.

## Current limitations

The first production slice intentionally leaves these for the next host-runtime iteration:

- native ACP `session/resume` / reconnect after Mission process restart;
- mid-turn steering semantics;
- richer native capability catalog projection from the live DSH session;
- arbitrary host capability invocation through this binding;
- optional live smoke test against an installed credentialed DSH instance.

Normal CI instead runs a fake ACP agent over the same official SDK and verifies initialize, session creation, prompt/update flow, permission round trip, cancellation, stop, and workspace admission without requiring a local DSH installation.
