#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('src/core/mission/controller.ts')
s=p.read_text()
old='''        work.purpose === "repair" && !["succeeded", "invalidated", "superseded", "abandoned"].includes(work.status)'''
new='''        work.purpose === "repair" && !["succeeded", "failed", "invalidated", "superseded", "abandoned"].includes(work.status)'''
if old not in s:
    raise SystemExit('existing repair guard not found')
p.write_text(s.replace(old,new,1))
PY
