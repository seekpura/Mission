#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p=Path('src/runtime/orchestration/mission-orchestrator.ts')
s=p.read_text()

def rep(old,new):
    global s
    if new in s: return
    if old not in s: raise SystemExit(f'anchor missing: {old[:120]!r}')
    s=s.replace(old,new,1)

rep('''import type { WorkerKnowledgeIngestor } from "../../core/knowledge/worker-knowledge-ingestor.ts";''', '''import type { WorkerKnowledgeIngestor } from "../../core/knowledge/worker-knowledge-ingestor.ts";\nimport { KnowledgeContextSelector } from "../../core/context/knowledge-context-selector.ts";''')
rep('''  private readonly knowledgeIngestor?: WorkerKnowledgeIngestor;\n  private readonly running''', '''  private readonly knowledgeIngestor?: WorkerKnowledgeIngestor;\n  private readonly knowledgeSelector = new KnowledgeContextSelector();\n  private readonly running''')
rep('''    const requirements = await this.projections.listRequirements(work.missionId);\n    const knownArtifacts = await this.projections.listArtifacts(work.missionId);\n    const contextPacket = this.contextCompiler.compile({\n      state,\n      workItem: work,\n      requirementRefs: work.requirementRefs,\n      artifactRefs: knownArtifacts.map(a => `${a.id}@${a.version}`),\n      capabilityRefs: capabilities.map(capability => capability.id)\n    });\n    const workerContext = {\n      contextPacket,\n      requirements: requirements.filter(r => work.requirementRefs.includes(r.id)),\n      expectedOutputs: work.expectedOutputs,\n      capabilities,''', '''    const [requirements, knownArtifacts, knownSources, knownTruths] = await Promise.all([\n      this.projections.listRequirements(work.missionId),\n      this.projections.listArtifacts(work.missionId),\n      this.projections.listSources(work.missionId),\n      this.projections.listTruths(work.missionId)\n    ]);\n    const knowledgeContext = this.knowledgeSelector.select({ workItem: work, truths: knownTruths, sources: knownSources });\n    const contextPacket = this.contextCompiler.compile({\n      state,\n      workItem: work,\n      requirementRefs: work.requirementRefs,\n      truthRefs: knowledgeContext.truths.map(truth => truth.id),\n      sourceRefs: knowledgeContext.sources.map(source => source.id),\n      artifactRefs: knownArtifacts.map(a => `${a.id}@${a.version}`),\n      capabilityRefs: capabilities.map(capability => capability.id)\n    });\n    const workerContext = {\n      contextPacket,\n      requirements: requirements.filter(r => work.requirementRefs.includes(r.id)),\n      truths: knowledgeContext.truths,\n      sources: knowledgeContext.sources,\n      expectedOutputs: work.expectedOutputs,\n      capabilities,''')
p.write_text(s)
PY
