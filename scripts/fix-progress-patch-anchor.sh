#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('scripts/apply-progress-plateau.sh')
s=p.read_text()
old="""'''  relatedWorkItems?: WorkItem[];\\n  priorRepairCount?: number;\\n}''',
'''  relatedWorkItems?: WorkItem[];\\n  priorRepairCount?: number;\\n  plateauContext?: PlateauContext;\\n}''')"""
new="""'''    relatedWorkItems?: WorkItem[];\\n    priorRepairCount?: number;\\n  }):''',
'''    relatedWorkItems?: WorkItem[];\\n    priorRepairCount?: number;\\n    plateauContext?: PlateauContext;\\n  }):''')"""
if old not in s:
    raise SystemExit('deliberation anchor block not found in patch script')
p.write_text(s.replace(old,new,1))
PY
