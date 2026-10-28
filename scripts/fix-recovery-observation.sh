#!/usr/bin/env bash
set -euo pipefail
python - <<'PY'
from pathlib import Path
p=Path('src/runtime/recovery/recovery-observation-inspector.ts')
s=p.read_text()
s=s.replace('export class RecoveryObservationInspector {\n  constructor(private readonly workspaces: WorkspaceManager) {}', 'export class RecoveryObservationInspector {\n  private readonly workspaces: WorkspaceManager;\n  constructor(workspaces: WorkspaceManager) { this.workspaces = workspaces; }')
p.write_text(s)
PY
