#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('scripts/apply-progress-plateau.sh')
s=p.read_text()
old="""'''          relatedWorkItems,\\n          priorRepairCount\\n        }));''',
'''          relatedWorkItems,\\n          priorRepairCount,\\n          plateauContext: plateauAssessment?.context\\n        }));''')"""
new="""'''          relatedWorkItems,\\n          priorRepairCount\\n        });''',
'''          relatedWorkItems,\\n          priorRepairCount,\\n          plateauContext: plateauAssessment?.context\\n        });''')"""
if old not in s:
    raise SystemExit('controller diagnosis anchor block not found in patch script')
p.write_text(s.replace(old,new,1))
PY
