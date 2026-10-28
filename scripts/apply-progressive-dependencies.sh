#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text()
    if new in s:
        return
    if old not in s:
        raise SystemExit(f'anchor missing in {path}: {old[:180]!r}')
    p.write_text(s.replace(old,new,1))

controller=Path('src/core/mission/controller.ts')
s=controller.read_text()
baseline='''    if (this.deliberation && (this.shouldPlanFrontier(state) || (input.trigger === "user_steering" && state.blockingGapIds.length === 0))) {'''
first_patch='''    const acceptanceBeforePlanning = await this.acceptanceEvaluation(input.missionId);\n    if (this.deliberation && !acceptanceBeforePlanning.satisfied && (this.shouldPlanFrontier(state) || (input.trigger === "user_steering" && state.blockingGapIds.length === 0))) {'''
final_patch='''    const acceptanceBeforePlanning = await this.acceptanceEvaluation(input.missionId);\n    const existingWorkBeforePlanning = await this.readModel.workItems(input.missionId);\n    const needsBootstrapFrontier = existingWorkBeforePlanning.length === 0 && state.finalArtifactRefs.length === 0;\n    if (this.deliberation && (!acceptanceBeforePlanning.satisfied || needsBootstrapFrontier) && (this.shouldPlanFrontier(state) || (input.trigger === "user_steering" && state.blockingGapIds.length === 0))) {'''
if final_patch not in s:
    if first_patch in s: s=s.replace(first_patch, final_patch, 1)
    elif baseline in s: s=s.replace(baseline, final_patch, 1)
    else: raise SystemExit('planning gate anchor missing')
controller.write_text(s)

replace('src/core/mission/controller.ts',
'''      && state.verifyingWorkItemIds.length === 0\n      && state.activeExecutionIds.length === 0\n      && state.finalArtifactRefs.length === 0;''',
'''      && state.verifyingWorkItemIds.length === 0\n      && state.activeExecutionIds.length === 0;''')

replace('src/runtime/orchestration/mission-orchestrator.ts',
'''import type { WorkItem } from "../../core/domain/work-item.ts";''',
'''import type { WorkItem } from "../../core/domain/work-item.ts";\nimport type { Artifact } from "../../core/domain/artifact.ts";''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''      const ready = (await this.projections.listWorkItems(missionId))\n        .filter(work => work.status === "ready")\n        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));\n      if (ready.length === 0) return;''',
'''      const allReady = (await this.projections.listWorkItems(missionId))\n        .filter(work => work.status === "ready")\n        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));\n      if (allReady.length === 0) return;\n      const dependencyArtifacts = await this.projections.listArtifacts(missionId);\n      const ready = allReady.filter(work => artifactDependenciesSatisfied(work, dependencyArtifacts));\n      if (ready.length === 0) return;''')

p=Path('src/runtime/orchestration/mission-orchestrator.ts'); s=p.read_text()
if 'function artifactDependenciesSatisfied(' not in s:
    s=s.rstrip()+'''\n\nfunction artifactDependenciesSatisfied(work: WorkItem, artifacts: Artifact[]): boolean {\n  const dependencies = work.artifactDependencies ?? [];\n  if (dependencies.length === 0) return true;\n  return dependencies.every(dependency => {\n    const matches = artifacts.filter(artifact => artifact.logicalName === dependency.logicalName\n      && (!dependency.type || artifact.type === dependency.type)\n      && !["invalid", "superseded"].includes(artifact.status));\n    if (matches.length === 0) return false;\n    const latest = matches.sort((a, b) => b.version - a.version)[0]!;\n    return artifactStatusMeets(latest.status, dependency.minimumStatus ?? "verified");\n  });\n}\n\nfunction artifactStatusMeets(status: Artifact["status"], minimum: "candidate" | "verified" | "final"): boolean {\n  const rank: Record<Artifact["status"], number> = { working: 0, candidate: 1, verified: 2, integrated: 3, final: 4, invalid: -1, superseded: -1 };\n  const required = minimum === "candidate" ? 1 : minimum === "verified" ? 2 : 4;\n  return rank[status] >= required;\n}\n'''
    p.write_text(s)
PY
