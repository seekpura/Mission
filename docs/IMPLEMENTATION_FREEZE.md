# Implementation Freeze 1

The following boundaries are stable for v0.1 unless E2E evidence demonstrates a structural defect:

1. `MissionController` consumes state and emits decisions/work; it does not call DeepSeek Harness internals directly.
2. `HostAdapter` is the only host-facing boundary.
3. `ExecutionBackend` is the execution-plane boundary.
4. Mission continuity is event/snapshot based, never dependent on agent chat history.
5. Workers produce candidate outputs. Runtime artifact commit + verifier evidence determines promotion.
6. Findings become Gaps. The Decision loop chooses repair/retry/replan/replace.
7. Capability acquisition is need-driven and mission-local by default.
8. External candidates must be inspected before activation.
9. Complex artifacts default to single-writer semantics.
10. Completion requires acceptance/evidence gates plus a completion challenge; producer self-claim is insufficient.
