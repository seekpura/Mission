# Mission Runtime — DeepSeek Harness integration

This directory is the reference-host integration for DeepSeek Harness. Mission Core remains host-independent.

The binding targets the public DSH surfaces verified against `deepseek-ai/deepseek-harness@22ddee3792402c3e70ec5f86a63c3e3e895a2f60`:

- Cordis plugin `apply(ctx)` + `inject`
- `ctx.agents.create(...)`
- `Agent.followup(...)`, `steer(...)`, `cancel(...)`, `whenIdle()`
- `ctx.tools.schemas()` and `ctx.tools.execute(...)`
- `createUserMessage(...)`

Load from a DeepSeek Harness source checkout with a patch overlay based on `cordis.yml.example`.

Current exposed tools:

- `mission_start`
- `mission_status`
- `mission_steer`
- `mission_cycle` (operator/debug surface; it will be removed from ordinary UX once the autonomous dispatcher owns wakeups)

The plugin does not copy DSH Skills into Mission. It snapshots DSH tool capabilities and lets Mission agents use the Host's existing composition.
