# Architecture Freeze 1

This source tree is the implementation baseline for the Mission Runtime discussed in the conversation.

Frozen principles:

1. Host/Harness supplies installed Skills, Tools, MCP, Agents and native execution capability.
2. Mission Runtime owns goal interpretation, acceptance, state, planning, orchestration, artifact/evidence/gap handling, secure capability acquisition, verification and completion.
3. Workflows and agent organization are dynamic, not hard-coded by artifact type.
4. Mission state is durable; agents are disposable.
5. Artifacts are verified independently; producer self-claims do not make an artifact final.
6. Missing capabilities may be discovered externally, but external code must pass acquisition/security/sandbox gates before mission-local activation.
7. DeepSeek Harness is the first reference host, not a dependency of core.
8. Architecture Freeze F0-F8 remains the design baseline; implementation changes must preserve these boundaries unless E2E evidence demonstrates a structural flaw.
