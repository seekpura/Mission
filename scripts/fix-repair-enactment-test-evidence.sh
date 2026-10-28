#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('tests/integration/repair-enactment.test.ts')
s=p.read_text()
old='''  await controller.emit(missionId, "execution.invocation.recorded", { receipt: {\n    id: "inv-old", missionId, workItemId: "w-broken", attemptId: "a-old", executionId: "e-old", route: "host_capability",\n    routeReason: "old route", capabilityRefs: ["cap-old"], targetRef: "cap-old", sideEffects: [], result: "failed",\n    startedAt: now, endedAt: now, createdAt: now\n  } }, { type: "system" });\n  await controller.openGap(missionId, { id: "g1", severity: "major", description: "renderer output is invalid", requirementRefs: ["r1"] });'''
new='''  await controller.emit(missionId, "execution.invocation.recorded", { receipt: {\n    id: "inv-old", missionId, workItemId: "w-broken", attemptId: "a-old", executionId: "e-old", route: "host_capability",\n    routeReason: "old route", capabilityRefs: ["cap-old"], targetRef: "cap-old", sideEffects: [], result: "failed",\n    startedAt: now, endedAt: now, createdAt: now\n  } }, { type: "system" });\n  await controller.recordEvidence(missionId, {\n    id: "ev-route", missionId, subjectRef: "cap-old", type: "runtime-check",\n    claim: "The selected capability produced a semantically invalid result", result: "contradicts", producedBy: "runtime", createdAt: now\n  });\n  await controller.emit(missionId, "finding.created", { finding: {\n    id: "f-route", missionId, category: "technical", severity: "major", observation: "The same execution path failed the required semantic contract",\n    expected: "A valid artifact from a working execution path", requirementRefs: ["r1"], evidenceRefs: ["ev-route"], confidence: 0.95, reproducible: true, createdAt: now\n  } }, { type: "verifier" });\n  await controller.openGap(missionId, { id: "g1", severity: "major", description: "renderer output is invalid", requirementRefs: ["r1"], findingRefs: ["f-route"] });'''
if old not in s:
    raise SystemExit('seed evidence pattern not found')
p.write_text(s.replace(old,new,1))
PY
