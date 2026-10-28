#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('scripts/apply-progress-plateau.sh')
s=p.read_text()
old="""'''Prior repair attempts: ${input.priorRepairCount ?? 0}\\nChoose the minimum sufficient intervention scope.''',
'''Prior repair attempts: ${input.priorRepairCount ?? 0}\\nProgress / plateau context: ${JSON.stringify(input.plateauContext ?? null)}\\nIf progress has stalled, consider a broader intervention than the already-attempted scopes, but only when the supplied findings/evidence support that root cause.\\nChoose the minimum sufficient intervention scope.''')"""
new="""'''Prior repair count: ${input.priorRepairCount ?? 0}\\nGenerate competing root-cause hypotheses before choosing a repair scope.''',
'''Prior repair count: ${input.priorRepairCount ?? 0}\\nProgress / plateau context: ${JSON.stringify(input.plateauContext ?? null)}\\nIf progress has stalled, consider a broader intervention than the already-attempted scopes, but only when the supplied findings/evidence support that root cause.\\nGenerate competing root-cause hypotheses before choosing a repair scope.''')"""
if old not in s:
    raise SystemExit('host prompt anchor block not found in patch script')
p.write_text(s.replace(old,new,1))
PY
