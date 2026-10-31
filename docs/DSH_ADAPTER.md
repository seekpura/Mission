# DeepSeek Harness Adapter Boundary

DeepSeek Harness is the first reference host, not a dependency of Mission Core.

The adapter is responsible for:

- host/environment description
- installed skill/tool/agent capability discovery
- agent create / resume / observe / steer / cancel
- host-native capability invocation where the concrete provider exposes one
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

`src/hosts/deepseek/acp-process-bindings.ts` is the concrete production binding.

It uses the standard ACP v1 automation surface rather than importing DeepSeek Harness internals:

- launches `dsh --profile acp` as a child process;
- communicates over newline-delimited JSON on stdio with `@agentclientprotocol/sdk@1.4.0`;
- initializes the ACP connection and creates a native DSH session rooted at the Mission workspace;
- when the agent advertises `agentCapabilities.sessionCapabilities.resume`, reconnects an existing native session with the same Mission workspace and current Runtime-owned MCP declarations after process restart;
- sends the compiled Mission work context as the first prompt for new work and the bounded recovery context after resume;
- normalizes ACP session updates into `HostAgentEvent` values;
- bridges `session/request_permission` to a Mission approval handler and selects only advertised one-shot allow/reject options;
- requests standard ACP `session/cancel` first, then uses a bounded process-kill fallback;
- closes the ACP session/connection and reaps the child process when a turn terminates.

The binding does not grant permissions up front and does not bypass DSH sandbox or approval policy. The host remains authoritative for native tool restrictions.

## Agent Skill delivery

Production Agent Skill acquisition is Mission-owned and opt-in. After immutable materialization, security/policy gates, explicit approval and strong-isolation smoke, only the validated Skill bundle is activated Mission-locally.

For a Work attempt, `CapabilityWorkspaceHostAdapter` projects only the acquired Skill refs authorized by that Work into `<workspace>/.agents/skills/<skill-name>/`. The DSH ACP process is launched in that same workspace, so the provider consumes the attempt-scoped native filesystem Skill catalog instead of receiving third-party Skill instructions through the Mission prompt.

Resume/reconnect rebuilds the same Work-scoped projection from durable Mission capability refs. Unreferenced Mission-local Skills are not exposed to the resumed Worker.

## Current limitations

The remaining limitations are provider-contract boundaries rather than placeholder features:

- **mid-turn steering:** standard ACP v1 exposes prompt turns and `session/cancel`, but no standard client-to-agent mid-turn steering method. `steerAgent()` therefore remains fail-closed instead of calling a provider-private extension or misrepresenting a second prompt as steering;
- **provider-native capability catalog:** the pre-session ACP environment does not expose a stable provider-wide model/reasoning/team catalog comparable to Codex `model/list`, so Mission does not fabricate those capabilities;
- **arbitrary host capability invocation:** this binding does not expose a provider contract for arbitrary `invokeHostCapability` execution and returns an explicit unsupported result;
- **installed credentialed smoke:** normal CI uses a fake ACP agent over the official SDK. An optional live smoke test against a locally installed credentialed DSH instance remains deployment-specific rather than a required CI dependency.

ACP resume/reconnect is no longer a limitation: the binding checks the agent-advertised resume capability and uses standard `session/resume`, preserving the Mission workspace and Runtime-owned MCP declarations across a new provider process.