#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p = Path('src/core/mission/controller.ts')
s = p.read_text()
old = '''        const diagnosis = normalizeGapDiagnosis(rawDiagnosis, {\n          findingRefs: findings.map(finding => finding.id),\n          evidenceRefs: evidence.map(item => item.id),\n          priorRepairCount\n        });'''
new = '''        const diagnosis = normalizeGapDiagnosis(rawDiagnosis, {\n          findingRefs: findings.map(finding => finding.id),\n          evidenceRefs: evidence.map(item => item.id),\n          priorRepairCount,\n          minimumRepairScope: plateauAssessment?.context.minimumRepairScope\n        });'''
if new in s:
    raise SystemExit(0)
if old not in s:
    raise SystemExit('controller diagnosis normalization anchor not found')
p.write_text(s.replace(old, new, 1))
PY
