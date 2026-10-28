#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('tests/e2e/reference-mission-fault-injection.test.ts')
s=p.read_text()
old='''  assert.deepEqual(recovery.recovered, [recoveryExecutionId]);\n  assert.deepEqual(recovery.lost, []);\n  await runtime.orchestrator!.runUntilQuiescent(missionId);'''
new='''  assert.deepEqual(recovery.recovered, [recoveryExecutionId]);\n  assert.deepEqual(recovery.lost, []);\n  const recoveryAcceptance = await runtime.controller.acceptanceEvaluation(missionId);\n  console.error("REFERENCE_RECOVERY_ACCEPTANCE", JSON.stringify(recoveryAcceptance));\n  console.error("REFERENCE_RECOVERY_REQUIREMENTS", JSON.stringify(await runtime.projections.listRequirements(missionId)));\n  console.error("REFERENCE_RECOVERY_ARTIFACTS", JSON.stringify((await runtime.projections.listArtifacts(missionId)).map(a => ({ref:`${a.id}@${a.version}`,logicalName:a.logicalName,status:a.status}))));\n  console.error("REFERENCE_RECOVERY_VERIFICATIONS", JSON.stringify((await runtime.projections.listVerificationResults(missionId)).map(v => ({artifactRef:v.artifactRef,overall:v.overall,checks:v.checkResults.map(c=>({id:c.id,status:c.status}))}))));\n  console.error("REFERENCE_RECOVERY_GAPS", JSON.stringify(await runtime.projections.listGaps(missionId)));\n  console.error("REFERENCE_RECOVERY_STATE", JSON.stringify(await runtime.controller.state(missionId)));\n  console.error("REFERENCE_RECOVERY_BUDGET", JSON.stringify(await runtime.budget.assess(missionId)));\n  await runtime.orchestrator!.runUntilQuiescent(missionId);'''
if old not in s: raise SystemExit('reference acceptance instrumentation anchor missing')
p.write_text(s.replace(old,new,1))
PY
