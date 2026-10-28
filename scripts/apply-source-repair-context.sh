#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text()
    if new in s: return
    if old not in s: raise SystemExit(f'anchor missing in {path}: {old[:140]!r}')
    p.write_text(s.replace(old,new,1))

replace('src/core/domain/verification.ts',
'''  artifactRefs: string[];\n  status: "open"''',
'''  artifactRefs: string[];\n  sourceRefs?: string[];\n  status: "open"''')

replace('src/core/mission/controller.ts',
'''async openGap(missionId: string, payload: { id: string; severity: "critical" | "major" | "minor"; description: string; blocking?: boolean; category?: Gap["category"]; requirementRefs?: string[]; artifactRefs?: string[]; findingRefs?: string[] })''',
'''async openGap(missionId: string, payload: { id: string; severity: "critical" | "major" | "minor"; description: string; blocking?: boolean; category?: Gap["category"]; requirementRefs?: string[]; artifactRefs?: string[]; findingRefs?: string[]; sourceRefs?: string[] })''')
replace('src/core/mission/controller.ts',
'''      objective: `Resolve gap: ${gap.description}. Diagnosed cause: ${diagnosis.rootCause}. Repair scope: ${diagnosis.repairScope ?? "work_item"}`,''',
'''      objective: `Resolve gap: ${gap.description}. Diagnosed cause: ${diagnosis.rootCause}. Repair scope: ${diagnosis.repairScope ?? "work_item"}${gap.sourceRefs?.length ? `. Sources requiring refresh: ${gap.sourceRefs.join(", ")}` : ""}`,''')

replace('src/core/knowledge/knowledge-staleness-manager.ts',
'''      artifactRefs: affectedArtifacts,\n      findingRefs: []''',
'''      artifactRefs: affectedArtifacts,\n      sourceRefs: [sourceId],\n      findingRefs: []''')

replace('src/persistence/sqlite/sqlite-entity-projector.ts',
'''          artifactRefs: payload.artifactRefs ?? [],\n          status: "open",''',
'''          artifactRefs: payload.artifactRefs ?? [],\n          sourceRefs: payload.sourceRefs ?? [],\n          status: "open",''')

replace('src/persistence/sqlite/sqlite-assurance-projector.ts',
'''          artifactRefs: unique([...(current?.artifactRefs ?? []), ...(incoming.artifactRefs ?? [])]),\n          status:''',
'''          artifactRefs: unique([...(current?.artifactRefs ?? []), ...(incoming.artifactRefs ?? [])]),\n          sourceRefs: unique([...(current?.sourceRefs ?? []), ...(incoming.sourceRefs ?? [])]),\n          status:''')

replace('src/core/mission/mission-read-model.ts',
'''          artifactRefs: payload.artifactRefs ?? [],\n          status: "open",''',
'''          artifactRefs: payload.artifactRefs ?? [],\n          sourceRefs: payload.sourceRefs ?? [],\n          status: "open",''')

replace('src/runtime/orchestration/mission-orchestrator.ts',
'''    const [requirements, knownArtifacts, knownSources, knownTruths] = await Promise.all([\n      this.projections.listRequirements(work.missionId),\n      this.projections.listArtifacts(work.missionId),\n      this.projections.listSources(work.missionId),\n      this.projections.listTruths(work.missionId)\n    ]);\n    const knowledgeContext = this.knowledgeSelector.select({ workItem: work, truths: knownTruths, sources: knownSources });''',
'''    const [requirements, knownArtifacts, knownSources, knownTruths, knownGaps] = await Promise.all([\n      this.projections.listRequirements(work.missionId),\n      this.projections.listArtifacts(work.missionId),\n      this.projections.listSources(work.missionId),\n      this.projections.listTruths(work.missionId),\n      this.projections.listGaps(work.missionId)\n    ]);\n    const knowledgeContext = this.knowledgeSelector.select({ workItem: work, truths: knownTruths, sources: knownSources, gaps: knownGaps });''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''      truths: knowledgeContext.truths,\n      sources: knowledgeContext.sources,\n      expectedOutputs:''',
'''      truths: knowledgeContext.truths,\n      sources: knowledgeContext.sources,\n      gaps: knowledgeContext.relatedGaps,\n      invalidatedKnowledge: { truths: knowledgeContext.diagnosticTruths, sources: knowledgeContext.diagnosticSources },\n      expectedOutputs:''')
PY
