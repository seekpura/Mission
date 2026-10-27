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

`src/hosts/deepseek/deepseek-host-adapter.ts` defines the compile-time boundary. Concrete DSH runtime bindings are intentionally injected through `DeepSeekBindings`, so DSH package details do not leak into core.
