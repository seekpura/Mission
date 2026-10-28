import type { Artifact } from "../domain/artifact.ts";
import type { AcceptanceContract, Requirement } from "../domain/mission.ts";
import type { Evidence, VerificationResult } from "../domain/verification.ts";

export interface AcceptanceEvaluation {
  satisfied: boolean;
  unsatisfiedRequirementIds: string[];
  missingArtifacts: string[];
  missingValidations: string[];
  reasons: string[];
}

export class AcceptanceEvaluator {
  evaluate(input: {
    contract: AcceptanceContract | null;
    requirements: Requirement[];
    artifacts: Artifact[];
    evidence: Evidence[];
    verifications: VerificationResult[];
  }): AcceptanceEvaluation {
    const { contract } = input;
    if (!contract) {
      return { satisfied: false, unsatisfiedRequirementIds: [], missingArtifacts: [], missingValidations: [], reasons: ["AcceptanceContract is missing"] };
    }

    const requirements = input.requirements.length > 0 ? input.requirements : contract.requirements;
    const required = requirements.filter(r => r.priority === "critical" || r.priority === "required");
    const unsatisfied = required.filter(r => r.status !== "satisfied").map(r => r.id);

    const validArtifacts = input.artifacts.filter(a => ["verified", "integrated", "final"].includes(a.status));
    const missingArtifacts = contract.requiredArtifacts
      .filter(requiredArtifact => !validArtifacts.some(artifact =>
        artifact.logicalName === requiredArtifact.logicalName
        && (!requiredArtifact.type || artifact.type === requiredArtifact.type)
      ))
      .map(item => item.logicalName);

    const supportingEvidence = new Set(input.evidence.filter(e => e.result === "supports").map(e => e.id));
    const missingValidations = contract.requiredValidations
      .filter(validation => {
        const exactCheckPassed = input.verifications.some(result =>
          result.checkResults.some(check => check.id === `validation-${validation.id}` && check.status === "pass")
        );
        if (exactCheckPassed) return false;
        return !requirements.some(req =>
          validation.requirementRefs.includes(req.id)
          && req.status === "satisfied"
          && req.evidenceRefs.some(ref => supportingEvidence.has(ref))
        );
      })
      .map(validation => validation.id);

    const reasons: string[] = [];
    if (unsatisfied.length) reasons.push(`Unsatisfied required requirements: ${unsatisfied.join(", ")}`);
    if (missingArtifacts.length) reasons.push(`Missing required artifacts: ${missingArtifacts.join(", ")}`);
    if (missingValidations.length) reasons.push(`Missing required validations: ${missingValidations.join(", ")}`);
    return {
      satisfied: unsatisfied.length === 0 && missingArtifacts.length === 0 && missingValidations.length === 0,
      unsatisfiedRequirementIds: unsatisfied,
      missingArtifacts,
      missingValidations,
      reasons
    };
  }
}
