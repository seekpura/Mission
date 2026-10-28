#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('scripts/apply-budget-cost-policy.sh')
s=p.read_text()
old="""# Persist authoritative usage after an execution result is available.\nrep('src/runtime/orchestration/mission-orchestrator.ts',\n'''      const { route: selectedRoute, result, approvalRef } = await this.executionRouter.execute({ work, route, capabilities, baseRequest });\\n      const envelope = parseWorkerOutput(result.finalOutput);''',\n'''      const { route: selectedRoute, result, approvalRef } = await this.executionRouter.execute({ work, route, capabilities, baseRequest });\\n      if (result.usage && Object.entries(result.usage).some(([key, value]) => key !== \"source\" && typeof value === \"number\" && value > 0)) {\\n        await this.controller.recordCost(work.missionId, {\\n          id: `cost-${executionId}`, missionId: work.missionId, executionId, attemptId, usage: result.usage, recordedAt: new Date().toISOString()\\n        });\\n      }\\n      const envelope = parseWorkerOutput(result.finalOutput);''')"""
new="""# Persist authoritative usage after an execution result is available.\nrep('src/runtime/orchestration/mission-orchestrator.ts',\n'''      const envelope = parseWorkerOutput(result.runtimeObservationRef);''',\n'''      if (result.usage && Object.entries(result.usage).some(([key, value]) => key !== \"source\" && typeof value === \"number\" && value > 0)) {\\n        await this.controller.recordCost(work.missionId, {\\n          id: `cost-${executionId}`, missionId: work.missionId, executionId, attemptId, usage: result.usage, recordedAt: new Date().toISOString()\\n        });\\n      }\\n      const envelope = parseWorkerOutput(result.runtimeObservationRef);''')"""
if old not in s:
    raise SystemExit('budget orchestrator usage anchor block not found')
p.write_text(s.replace(old,new,1))
PY
