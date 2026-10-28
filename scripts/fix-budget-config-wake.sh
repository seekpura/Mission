#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('src/runtime/mission-runtime.ts')
s=p.read_text()
old='''  async configureBudget(budget: MissionBudget): Promise<void> {\n    await this.budget.configure(budget);\n    this.orchestrator?.wake(budget.missionId);\n  }'''
new='''  async configureBudget(budget: MissionBudget): Promise<void> {\n    await this.budget.configure(budget);\n  }'''
if new in s:
    raise SystemExit(0)
if old not in s:
    raise SystemExit('configureBudget wake anchor not found')
p.write_text(s.replace(old,new,1))
PY
