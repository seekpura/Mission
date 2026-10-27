# DeepSeek Harness Reference Host Adapter

DeepSeek Harness is the first reference host, not a Mission Core dependency.

## Upstream contract pinned for the current integration

The binding was inspected against:

`deepseek-ai/deepseek-harness@22ddee3792402c3e70ec5f86a63c3e3e895a2f60`

Mission intentionally binds to documented/public structural surfaces rather than importing DSH implementation internals into Core:

- Cordis plugins export `apply(ctx)` and may declare `inject`.
- Agent creation uses `ctx.agents.create({ sessionId, parentAgent?, meta?, agentOptions? })`.
- Agent driving uses `followup`, `steer`, `cancel` and `whenIdle`.
- Host tool observation uses `ctx.tools.schemas()`.
- Programmatic host tool execution uses `ctx.tools.execute(...)`.
- User-facing messages use DSH `createUserMessage`.

`src/hosts/deepseek/official-bindings.ts` is the compatibility boundary. `integrations/deepseek-plugin/` supplies the actual DSH package imports and a loadable plugin surface.

## Ownership boundary

DSH owns:

- Agent/session lifecycle implementation
- Installed tool/Skill/MCP composition
- Model/provider routing
- Native approval and tool execution machinery

Mission owns:

- MissionSpec and AcceptanceContract
- progressive planning and dynamic frontier
- durable Mission state and projections
- gaps, decisions, artifact/evidence state
- capability need/acquisition policy
- completion and verification logic

A future DSH API change should be absorbed inside the reference-host integration without changing Mission Core domain contracts.
