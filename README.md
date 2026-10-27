# Mission Runtime

Mission Runtime is a host-independent control plane for long-running autonomous missions.

It owns Mission interpretation, AcceptanceContract, progressive planning, context, dynamic orchestration, artifact/evidence/gap state, verification, capability resolution/acquisition policy, execution coordination, recovery, and completion. Host harnesses provide agents, tools, skills, MCP servers, browsers, shells, applications, and native execution capabilities.

DeepSeek Harness is the first reference host. Core code does not import DeepSeek Harness internals.

## Current development baseline

This repository is the live implementation baseline derived from Architecture Freeze F0-F8.

Implemented now:

- durable SQLite event store and materialized Mission projections
- MissionSpec + real AcceptanceContract / Requirement / Evidence hard completion matrix
- rolling Strategy/Frontier planning and Gap-driven repair
- autonomous MissionOrchestrator with bounded concurrent Host-Agent execution
- structured worker output contract and isolated workspaces
- versioned SHA-256 Artifact Store
- Artifact -> Verification -> Evidence -> Requirement -> Completion chain
- independent Completion Challenger after deterministic gates
- LocalExecutionBackend and HostAgentExecutionBackend
- DeepSeek Harness official public-surface binding and loadable Mission plugin
- capability resolver, discovery abstractions, mission-local overlay and static security scanner
- HTTP/SSE Mission API and Mission Control surface
- automated unit/integration/E2E tests

The runtime remains task-dynamic: it does not hard-code presentation/video/coding workflows, permanent agent teams, or a fixed DAG.

## Run

Requires Node.js 22.5+.

```bash
npm test
npm run smoke
npm run server
```

No third-party npm dependencies are required for the core runtime at the current checkpoint. `node:sqlite` is used directly.

## Architecture and status

- `ARCHITECTURE_FREEZE.md`
- `docs/IMPLEMENTATION_FREEZE.md`
- `docs/DSH_ADAPTER.md`
- `docs/REFERENCE_MISSION.md`
- `CURRENT_STATUS.md`
