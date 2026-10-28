#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text()
    if new in s: return
    if old not in s: raise SystemExit(f'anchor missing in {path}: {old[:140]!r}')
    p.write_text(s.replace(old,new,1))

replace('src/runtime/orchestration/mission-orchestrator.ts',
'''import { KnowledgeContextSelector } from "../../core/context/knowledge-context-selector.ts";''',
'''import { KnowledgeContextSelector } from "../../core/context/knowledge-context-selector.ts";\nimport type { KnowledgeStalenessManager } from "../../core/knowledge/knowledge-staleness-manager.ts";''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''  private readonly knowledgeIngestor?: WorkerKnowledgeIngestor;\n  private readonly knowledgeSelector''',
'''  private readonly knowledgeIngestor?: WorkerKnowledgeIngestor;\n  private readonly knowledge?: KnowledgeStalenessManager;\n  private readonly knowledgeSelector''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''    knowledgeIngestor?: WorkerKnowledgeIngestor;\n    assurance?: ArtifactAssurancePipeline;''',
'''    knowledgeIngestor?: WorkerKnowledgeIngestor;\n    knowledge?: KnowledgeStalenessManager;\n    assurance?: ArtifactAssurancePipeline;''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''    this.knowledgeIngestor = input.knowledgeIngestor;\n    this.assurance =''',
'''    this.knowledgeIngestor = input.knowledgeIngestor;\n    this.knowledge = input.knowledge;\n    this.assurance =''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''  async runUntilQuiescent(missionId: string): Promise<void> {\n    for (let cycle = 0; cycle < this.maxCyclesPerWake; cycle++) {\n      await this.controller.runControllerCycle''',
'''  async runUntilQuiescent(missionId: string): Promise<void> {\n    for (let cycle = 0; cycle < this.maxCyclesPerWake; cycle++) {\n      await this.knowledge?.scanFreshness(missionId);\n      await this.controller.runControllerCycle''')
replace('src/runtime/mission-runtime.ts',
'''        knowledgeIngestor: new WorkerKnowledgeIngestor({ knowledge: this.knowledge, projections: this.projections }),\n        options:''',
'''        knowledgeIngestor: new WorkerKnowledgeIngestor({ knowledge: this.knowledge, projections: this.projections }),\n        knowledge: this.knowledge,\n        options:''')
PY
