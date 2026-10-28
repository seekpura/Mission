#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('src/core/mission/controller.ts')
s=p.read_text()
old='''      const existingRepair = relatedWorkItems.find(work =>\n        !["succeeded", "invalidated", "superseded", "abandoned"].includes(work.status)\n      );'''
new='''      const existingRepair = relatedWorkItems.find(work =>\n        work.purpose === "repair" && !["succeeded", "invalidated", "superseded", "abandoned"].includes(work.status)\n      );'''
if old not in s:
    raise SystemExit('existingRepair pattern not found')
p.write_text(s.replace(old,new,1))
PY
