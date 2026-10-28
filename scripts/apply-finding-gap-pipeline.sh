#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
p = Path('src/runtime/orchestration/artifact-assurance-pipeline.ts')
s = p.read_text()

def replace(old, new):
    global s
    if new in s:
        return
    if old not in s:
        raise SystemExit('expected pipeline snippet not found:\n' + old[:300])
    s = s.replace(old, new, 1)

replace(
'import type { Verifier } from "../../core/verification/verifier.ts";\n',
'import type { Verifier } from "../../core/verification/verifier.ts";\nimport { FindingGapManager } from "../../core/verification/finding-gap-manager.ts";\n'
)
replace(
'  private readonly verifier: Verifier;\n  private readonly inspectionService?: ArtifactInspectionService;\n',
'  private readonly verifier: Verifier;\n  private readonly findingGaps: FindingGapManager;\n  private readonly inspectionService?: ArtifactInspectionService;\n'
)
replace(
'    verifier: Verifier;\n    inspectionService?: ArtifactInspectionService;\n',
'    verifier: Verifier;\n    inspectionService?: ArtifactInspectionService;\n    findingGaps?: FindingGapManager;\n'
)
replace(
'    this.verifier = input.verifier;\n    this.inspectionService = input.inspectionService;\n',
'    this.verifier = input.verifier;\n    this.findingGaps = input.findingGaps ?? new FindingGapManager({ controller: input.controller, projections: input.projections });\n    this.inspectionService = input.inspectionService;\n'
)
old = '''    if (verification.overall === "fail" || verification.overall === "inconclusive") {
      const finding = this.verificationFinding(artifact, verification);
      await this.controller.emit(artifact.missionId, "finding.created", { finding }, { type: "verifier" }, `finding:${finding.id}`);
      const capabilityNeeds = inspection?.missingCapabilityNeeds ?? [];
      if (capabilityNeeds.length > 0 && verification.overall === "inconclusive") {
        return {
          status: "verification_blocked",
          reason: `verification blocked by missing inspection capability: ${capabilityNeeds.map(need => need.objective).join("; ")}`,
          artifactRef: `${artifact.id}@${artifact.version}`,
          capabilityNeeds
        };
      }
      await this.controller.openGap(artifact.missionId, {
        id: `verification-${artifact.id}-${artifact.version}`,
        severity: finding.severity === "critical" ? "critical" : "major",
        description: finding.observation,
        category: "quality",
        artifactRefs: [`${artifact.id}@${artifact.version}`],
        findingRefs: [finding.id],
        requirementRefs: explicitRequirementRefs
      });
      return { status: "failed", reason: `artifact verification failed: ${artifact.logicalName}`, artifactRef: `${artifact.id}@${artifact.version}`, capabilityNeeds: [] };
    }
'''
new = '''    if (verification.overall === "fail" || verification.overall === "inconclusive") {
      const finding = this.verificationFinding(artifact, verification);
      const capabilityNeeds = inspection?.missingCapabilityNeeds ?? [];
      const capabilityBlocked = capabilityNeeds.length > 0 && verification.overall === "inconclusive";
      await this.findingGaps.record(finding, {
        createGap: !capabilityBlocked,
        category: "quality",
        severity: finding.severity === "critical" ? "critical" : "major",
        description: finding.observation,
        artifactRefs: [`${artifact.id}@${artifact.version}`],
        requirementRefs: explicitRequirementRefs
      });
      if (capabilityBlocked) {
        return {
          status: "verification_blocked",
          reason: `verification blocked by missing inspection capability: ${capabilityNeeds.map(need => need.objective).join("; ")}`,
          artifactRef: `${artifact.id}@${artifact.version}`,
          capabilityNeeds
        };
      }
      return { status: "failed", reason: `artifact verification failed: ${artifact.logicalName}`, artifactRef: `${artifact.id}@${artifact.version}`, capabilityNeeds: [] };
    }
'''
replace(old, new)
replace(
'      confidence: 1,\n      createdAt: new Date().toISOString()\n',
'      confidence: 1,\n      checkId: failedCheck?.id,\n      reproducible: failedCheck?.method === "deterministic" || failedCheck?.method === "runtime" || failedCheck?.method === "integration",\n      createdAt: new Date().toISOString()\n'
)
p.write_text(s)
PY
