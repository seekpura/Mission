# Mission Runtime

Mission Runtime is a host-independent control plane for long-running autonomous missions.

It owns mission state, acceptance, progressive planning, context, dynamic orchestration, artifact/evidence/gap handling, verification, capability resolution/acquisition policy, execution coordination, recovery, and completion. Host harnesses provide agents, tools, skills, MCP servers, browsers, shells, applications, and native execution capabilities.

DeepSeek Harness is the first reference host. Core code must not import DeepSeek Harness internals.

## Current development baseline

This repository is the live implementation baseline derived from Architecture Freeze F0-F8.

Implemented now:

- durable SQLite append-only mission event store with optimistic concurrency
- mission state projection and snapshot support
- mission/acceptance/work/artifact/gap/decision/capability/execution domain contracts
- filesystem Artifact Store with versioned commits and content hashes
- local workspaces and process execution backend
- execution recovery by observation
- structured verification findings and gap creation
- policy engine primitives
- capability resolver and static security scanner
- host-independent HostAdapter contract
- FakeHost reference for tests
- DeepSeek Harness adapter boundary/interface scaffold
- Context Compiler manifest
- event-driven MissionController cycle
- HTTP + SSE Mission API
- automated unit/integration/E2E tests

The runtime remains task-dynamic: it does not hard-code presentation/video/coding workflows or permanent agent teams.

## Run

Requires Node.js 22.5+.

```bash
npm test
npm run smoke
npm run server
```

No third-party npm dependencies are required for the current build. `node:sqlite` is used directly.

## Architecture

See:

- `ARCHITECTURE_FREEZE.md`
- `docs/IMPLEMENTATION_FREEZE.md`
- `docs/DSH_ADAPTER.md`
- `docs/REFERENCE_MISSION.md`
- `CURRENT_STATUS.md`
