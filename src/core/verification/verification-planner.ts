import type { Artifact } from "../domain/artifact.ts";
import type { AcceptanceContract, Requirement } from "../domain/mission.ts";
import type { VerificationCheck, VerificationMethod, VerificationProfile } from "../domain/verification.ts";

export interface VerificationPlanningContext {
  acceptanceContract?: AcceptanceContract | null;
  requirements?: Requirement[];
  explicitRequirementRefs?: string[];
}

export class VerificationPlanner {
  plan(artifact: Artifact, context: VerificationPlanningContext = {}): VerificationProfile {
    const linked = this.linkedRequirements(artifact, context);
    const checks: VerificationCheck[] = [
      check("file-exists", "Artifact file exists", "structural", "structural", "deterministic", "critical", []),
      check("file-non-empty", "Artifact file is non-empty", "structural", "structural", "deterministic", "critical", [])
    ];

    for (const requirement of linked) {
      const method = methodForRequirement(requirement);
      if (method === "deterministic") continue;
      checks.push(check(
        `requirement-${requirement.id}`,
        requirement.description,
        categoryForRequirement(requirement),
        levelForRequirement(requirement),
        method,
        requirement.priority,
        [requirement.id]
      ));
    }

    for (const validation of context.acceptanceContract?.requiredValidations ?? []) {
      const refs = validation.requirementRefs.filter(ref => linked.some(requirement => requirement.id === ref));
      if (validation.requirementRefs.length > 0 && refs.length === 0) continue;
      const level = validation.level ?? "quality";
      checks.push(check(
        `validation-${validation.id}`,
        validation.description,
        level === "integration" ? "integration" : level === "functional" ? "functional" : "technical",
        level,
        methodForValidation(level, artifact.type),
        "required",
        refs
      ));
    }

    return { id: `profile-${artifact.type}-${fingerprint(checks)}`, artifactType: artifact.type, checks: dedupe(checks) };
  }

  private linkedRequirements(artifact: Artifact, context: VerificationPlanningContext): Requirement[] {
    const explicit = new Set(context.explicitRequirementRefs ?? []);
    const requiredArtifact = context.acceptanceContract?.requiredArtifacts.find(item => item.logicalName === artifact.logicalName && (!item.type || item.type === artifact.type));
    for (const ref of requiredArtifact?.requirementRefs ?? []) explicit.add(ref);
    return (context.requirements ?? []).filter(requirement => explicit.has(requirement.id));
  }
}

function methodForRequirement(requirement: Requirement): VerificationMethod {
  if (requirement.verification === "artifact") return "deterministic";
  if (requirement.verification === "test" || requirement.verification === "runtime") return "runtime";
  if (requirement.verification === "evidence") return "source";
  if (requirement.verification === "human") return "human";
  if (requirement.type === "visual" || requirement.type === "experience") return "perceptual";
  return "semantic";
}

function categoryForRequirement(requirement: Requirement): VerificationCheck["category"] {
  if (requirement.type === "visual" || requirement.type === "experience") return "visual";
  if (requirement.type === "content") return "content";
  if (requirement.type === "evidence") return "evidence";
  if (requirement.type === "functional") return "functional";
  if (requirement.type === "compliance") return "constraint";
  return "technical";
}

function levelForRequirement(requirement: Requirement): VerificationCheck["level"] {
  if (requirement.verification === "test" || requirement.verification === "runtime") return "functional";
  return "quality";
}

function methodForValidation(level: VerificationCheck["level"], artifactType: string): VerificationMethod {
  if (level === "structural") return "deterministic";
  if (level === "functional") return "runtime";
  if (level === "integration") return "integration";
  if (["presentation", "image", "video", "website"].includes(artifactType)) return "perceptual";
  return "semantic";
}

function check(id: string, description: string, category: VerificationCheck["category"], level: VerificationCheck["level"], method: VerificationMethod, priority: VerificationCheck["priority"], requirementRefs: string[]): VerificationCheck {
  return { id, description, category, level, method, priority, requirementRefs };
}

function dedupe(checks: VerificationCheck[]): VerificationCheck[] {
  const seen = new Set<string>();
  return checks.filter(check => {
    const key = `${check.id}:${check.method}:${check.requirementRefs.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fingerprint(checks: VerificationCheck[]): string {
  let hash = 2166136261;
  for (const char of checks.map(check => `${check.id}:${check.method}:${check.priority}`).sort().join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
