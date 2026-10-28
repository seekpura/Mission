#!/usr/bin/env bash
set -euo pipefail
python3 - "$1" <<'PY'
from pathlib import Path
import sys
p=Path('src/core/mission/controller.ts')
s=p.read_text()
marker='''\nfunction diagnosisId(gapId: string, diagnosis: GapDiagnosis, sequence: number): string { return `${gapId}:${diagnosis.intervention}:${sequence}`; }\n'''
if sys.argv[1] == 'add':
    if 'function diagnosisId(gapId: string, diagnosis: GapDiagnosis, sequence: number): string {' not in s:
        p.write_text(s + marker)
elif sys.argv[1] == 'remove':
    p.write_text(s.replace(marker, '\n'))
else:
    raise SystemExit('expected add|remove')
PY
