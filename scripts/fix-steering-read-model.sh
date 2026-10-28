#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('src/core/mission/mission-read-model.ts')
s=p.read_text()
s=s.replace('import type { AcceptanceContract, Requirement } from "../domain/mission.ts";', 'import type { AcceptanceContract, MissionSpec, Requirement } from "../domain/mission.ts";', 1)
marker='''  async acceptanceContract(missionId: string): Promise<AcceptanceContract | null> {'''
method='''  async missionSpec(missionId: string): Promise<MissionSpec | null> {\n    if (this.projections) return this.projections.getMissionSpec(missionId);\n    const events = await this.store.list(missionId);\n    for (let i = events.length - 1; i >= 0; i--) {\n      const event = events[i]!;\n      if (event.type !== "mission.spec.revised") continue;\n      const payload = event.payload as any;\n      const spec = payload.spec ?? payload;\n      return { missionId, revision: spec.revision ?? 1, objective: spec.objective ?? "", intent: spec.intent, requestedOutputs: spec.requestedOutputs ?? [], constraints: spec.constraints ?? [], preferences: spec.preferences ?? [], sourceRefs: spec.sourceRefs ?? [], createdAt: spec.createdAt ?? event.createdAt };\n    }\n    return null;\n  }\n\n'''
if marker not in s: raise SystemExit('acceptance marker not found')
p.write_text(s.replace(marker, method+marker, 1))
PY
