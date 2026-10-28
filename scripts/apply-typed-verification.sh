#!/usr/bin/env bash
set -euo pipefail
mkdir -p src/core/verification tests/unit tests/integration

python - <<'PY'
from pathlib import Path
p=Path('src/core/domain/verification.ts')
s=p.read_text()
insert='''\nexport type VerificationMethod = "deterministic" | "semantic" | "perceptual" | "runtime" | "source" | "human" | "integration";\n\nexport interface VerificationCheck {\n  id: string;\n  description: string;\n  category: "structural" | "functional" | "content" | "visual" | "technical" | "integration" | "evidence" | "constraint";\n  level: "structural" | "functional" | "quality" | "integration" | "mission";\n  method: VerificationMethod;\n  priority: "critical" | "required" | "preferred";\n  requirementRefs: string[];\n}\n\nexport interface VerificationProfile {\n  id: string;\n  artifactType: string;\n  checks: VerificationCheck[];\n}\n'''
if 'export type VerificationMethod' not in s:
    s = insert + '\n' + s
s=s.replace('export interface VerificationCheckResult {\n  id: string;\n  status:', 'export interface VerificationCheckResult {\n  id: string;\n  status:')
s=s.replace('  detail?: string;\n  evidenceRefs: string[];\n}', '  detail?: string;\n  evidenceRefs: string[];\n  method?: VerificationMethod;\n  priority?: "critical" | "required" | "preferred";\n  category?: VerificationCheck["category"];\n  requirementRefs?: string[];\n}')
p.write_text(s)
PY

cat > src/core/verification/verification-planner.ts <<'EOF'
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
EOF

cat > src/core/verification/check-executor.ts <<'EOF'
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";

export interface VerificationCheckExecutorContext {
  missionId: string;
}

export interface VerificationCheckExecutor {
  id: string;
  supports(check: VerificationCheck, artifact: Artifact): boolean;
  execute(artifact: Artifact, check: VerificationCheck, context: VerificationCheckExecutorContext): Promise<VerificationCheckResult>;
}
EOF

cat > src/core/verification/deterministic-file-check-executor.ts <<'EOF'
import { existsSync, statSync } from "node:fs";
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";
import type { VerificationCheckExecutor, VerificationCheckExecutorContext } from "./check-executor.ts";

export class DeterministicFileCheckExecutor implements VerificationCheckExecutor {
  id = "deterministic-file-checks";
  supports(check: VerificationCheck): boolean { return check.method === "deterministic" && ["file-exists", "file-non-empty"].includes(check.id); }
  async execute(artifact: Artifact, check: VerificationCheck, _context: VerificationCheckExecutorContext): Promise<VerificationCheckResult> {
    const exists = existsSync(artifact.uri);
    const pass = check.id === "file-exists" ? exists : exists && statSync(artifact.uri).size > 0;
    return result(check, pass ? "pass" : "fail", pass ? undefined : check.id === "file-exists" ? "Artifact file does not exist" : "Artifact file is empty");
  }
}

function result(check: VerificationCheck, status: VerificationCheckResult["status"], detail?: string): VerificationCheckResult {
  return { id: check.id, status, detail, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs };
}
EOF

cat > src/core/verification/verifier-registry.ts <<'EOF'
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck } from "../domain/verification.ts";
import type { VerificationCheckExecutor } from "./check-executor.ts";

export class VerifierRegistry {
  private readonly executors: VerificationCheckExecutor[];
  constructor(executors: VerificationCheckExecutor[] = []) { this.executors = [...executors]; }
  register(executor: VerificationCheckExecutor): void { this.executors.push(executor); }
  resolve(check: VerificationCheck, artifact: Artifact): VerificationCheckExecutor | undefined {
    return this.executors.find(executor => executor.supports(check, artifact));
  }
}
EOF

cat > src/core/verification/host-review-check-executor.ts <<'EOF'
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";
import type { HostAdapter } from "../../hosts/deepseek/host-adapter.ts";
import type { VerificationCheckExecutor, VerificationCheckExecutorContext } from "./check-executor.ts";

export class HostReviewCheckExecutor implements VerificationCheckExecutor {
  id = "independent-host-reviewer";
  private readonly host: HostAdapter;
  constructor(host: HostAdapter) { this.host = host; }
  supports(check: VerificationCheck): boolean { return ["semantic", "perceptual", "source"].includes(check.method); }

  async execute(artifact: Artifact, check: VerificationCheck, context: VerificationCheckExecutorContext): Promise<VerificationCheckResult> {
    const handle = await this.host.createAgent({
      missionId: context.missionId,
      workItemId: `verify:${artifact.id}:${check.id}`,
      workspaceRoot: undefined,
      allowedCapabilityRefs: [],
      context: {
        kind: "verification-review",
        independence: "You are an independent verifier. Do not assume the producer's claims are correct.",
        artifact: { id: artifact.id, version: artifact.version, type: artifact.type, uri: artifact.uri, logicalName: artifact.logicalName },
        check,
        responseContract: { status: "pass|fail|inconclusive", detail: "specific observation", confidence: "0..1" }
      }
    });
    let payload: unknown;
    for await (const event of this.host.observeAgent(handle)) {
      if (event.type === "failed") return result(check, "inconclusive", `Independent reviewer failed: ${extractError(event.payload)}`);
      if (event.type === "completed") payload = event.payload;
    }
    const verdict = parseVerdict(payload);
    if (!verdict) return result(check, "inconclusive", "Independent reviewer did not return a valid verification verdict");
    return result(check, verdict.status, verdict.detail);
  }
}

function parseVerdict(value: unknown): { status: "pass" | "fail" | "inconclusive"; detail?: string } | null {
  let candidate: any = value;
  if (typeof value === "string") {
    try { candidate = JSON.parse(value); } catch { return null; }
  }
  if (candidate && typeof candidate === "object" && typeof candidate.text === "string") {
    try { candidate = JSON.parse(candidate.text); } catch { return null; }
  }
  if (!candidate || typeof candidate !== "object" || !["pass", "fail", "inconclusive"].includes(candidate.status)) return null;
  return { status: candidate.status, detail: typeof candidate.detail === "string" ? candidate.detail : undefined };
}
function extractError(value: unknown): string { return value && typeof value === "object" && typeof (value as any).error === "string" ? (value as any).error : String(value); }
function result(check: VerificationCheck, status: VerificationCheckResult["status"], detail?: string): VerificationCheckResult {
  return { id: check.id, status, detail, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs };
}
EOF

cat > src/core/verification/profiled-verifier.ts <<'EOF'
import { randomUUID } from "node:crypto";
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationResult, VerificationCheckResult } from "../domain/verification.ts";
import type { Verifier, VerificationContext } from "./verifier.ts";
import { VerificationPlanner } from "./verification-planner.ts";
import { VerifierRegistry } from "./verifier-registry.ts";

export class ProfiledVerifier implements Verifier {
  id = "profiled-verifier";
  private readonly planner: VerificationPlanner;
  private readonly registry: VerifierRegistry;
  constructor(planner: VerificationPlanner, registry: VerifierRegistry) { this.planner = planner; this.registry = registry; }

  async verify(artifact: Artifact, context: VerificationContext = {}): Promise<VerificationResult> {
    const profile = this.planner.plan(artifact, context);
    const results: VerificationCheckResult[] = [];
    for (const check of profile.checks) {
      const executor = this.registry.resolve(check, artifact);
      if (!executor) {
        results.push({ id: check.id, status: "inconclusive", detail: `No verifier is available for required method: ${check.method}`, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs });
        continue;
      }
      results.push(await executor.execute(artifact, check, { missionId: artifact.missionId }));
    }
    const required = results.filter(result => result.priority !== "preferred");
    const hasFail = required.some(result => result.status === "fail");
    const hasInconclusive = required.some(result => result.status === "inconclusive");
    const hasWarning = results.some(result => result.status === "warning" || (result.priority === "preferred" && result.status !== "pass"));
    return {
      id: randomUUID(), missionId: artifact.missionId, artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: profile.id, verifierId: this.id,
      level: highestLevel(profile.checks.map(check => check.level)),
      overall: hasFail ? "fail" : hasInconclusive ? "inconclusive" : hasWarning ? "pass_with_warnings" : "pass",
      checkResults: results, findingRefs: [], evidenceRefs: [], createdAt: new Date().toISOString()
    };
  }
}

function highestLevel(levels: Array<"structural" | "functional" | "quality" | "integration" | "mission">) {
  const order = ["structural", "functional", "quality", "integration", "mission"] as const;
  return order[Math.max(0, ...levels.map(level => order.indexOf(level)))]!;
}
EOF

cat > src/core/verification/verifier.ts <<'EOF'
import type { Artifact } from "../domain/artifact.ts";
import type { AcceptanceContract, Requirement } from "../domain/mission.ts";
import type { VerificationResult } from "../domain/verification.ts";

export interface VerificationContext {
  acceptanceContract?: AcceptanceContract | null;
  requirements?: Requirement[];
  explicitRequirementRefs?: string[];
}

export interface Verifier {
  id: string;
  verify(artifact: Artifact, context?: VerificationContext): Promise<VerificationResult>;
}
EOF

python - <<'PY'
from pathlib import Path
p=Path('src/runtime/orchestration/artifact-assurance-pipeline.ts')
s=p.read_text()
s=s.replace('      const verification = await this.verifier.verify(artifact);', '      const contract = await this.projections.getAcceptanceContract(work.missionId);\n      const requirements = await this.projections.listRequirements(work.missionId);\n      const verification = await this.verifier.verify(artifact, { acceptanceContract: contract, requirements, explicitRequirementRefs: output.requirementRefs ?? [] });')
old='''      const evidence = this.verificationEvidence(artifact, verification);\n      await this.controller.recordEvidence(work.missionId, evidence);\n      const final = await this.isRequiredArtifact(work.missionId, artifact);\n      await this.controller.validateArtifact(work.missionId, `${artifact.id}@${artifact.version}`, final);\n      artifactRefs.push(`${artifact.id}@${artifact.version}`);\n      await this.satisfyArtifactRequirements(work.missionId, artifact, output.requirementRefs ?? [], evidence.id);'''
new='''      const evidenceIds = await this.recordVerificationEvidence(artifact, verification);\n      const final = await this.isRequiredArtifact(work.missionId, artifact);\n      await this.controller.validateArtifact(work.missionId, `${artifact.id}@${artifact.version}`, final);\n      artifactRefs.push(`${artifact.id}@${artifact.version}`);\n      await this.satisfyArtifactRequirements(work.missionId, artifact, output.requirementRefs ?? [], verification, evidenceIds);'''
if old not in s: raise SystemExit('pipeline evidence block missing')
s=s.replace(old,new)
start=s.index('  private async satisfyArtifactRequirements(')
end=s.index('  private async isRequiredArtifact', start)
replacement='''  private async satisfyArtifactRequirements(missionId: string, artifact: Artifact, explicitRequirementRefs: string[], verification: VerificationResult, evidenceByRequirement: Map<string, string[]>): Promise<void> {\n    const contract = await this.projections.getAcceptanceContract(missionId);\n    const requirements = await this.projections.listRequirements(missionId);\n    const requiredArtifact = contract?.requiredArtifacts.find(item => item.logicalName === artifact.logicalName && (!item.type || item.type === artifact.type));\n    const candidates = new Set([...(requiredArtifact?.requirementRefs ?? []), ...explicitRequirementRefs]);\n    for (const requirement of requirements) {\n      if (!candidates.has(requirement.id)) continue;\n      if (requirement.verification === "artifact") {\n        const structuralPass = verification.checkResults.filter(check => check.method === "deterministic").every(check => check.status === "pass");\n        if (structuralPass) await this.controller.setRequirementStatus(missionId, requirement.id, "satisfied", evidenceByRequirement.get(requirement.id) ?? []);\n        continue;\n      }\n      const relevant = verification.checkResults.filter(check => check.requirementRefs?.includes(requirement.id));\n      if (relevant.length > 0 && relevant.every(check => check.status === "pass")) {\n        await this.controller.setRequirementStatus(missionId, requirement.id, "satisfied", evidenceByRequirement.get(requirement.id) ?? []);\n      }\n    }\n  }\n\n  private async recordVerificationEvidence(artifact: Artifact, verification: VerificationResult): Promise<Map<string, string[]>> {\n    const byRequirement = new Map<string, string[]>();\n    for (const check of verification.checkResults.filter(check => check.status === "pass")) {\n      const evidence: Evidence = {\n        id: `evidence-${verification.id}-${check.id}`, missionId: artifact.missionId, subjectRef: `${artifact.id}@${artifact.version}`,\n        type: check.method === "runtime" ? "test-result" : check.method === "perceptual" ? "render-inspection" : check.method === "deterministic" ? "file-validation" : "automated-review",\n        claim: `${artifact.logicalName} passed ${check.id}`, result: "supports", sourceRef: verification.id, producedBy: verification.verifierId, createdAt: new Date().toISOString()\n      };\n      await this.controller.recordEvidence(artifact.missionId, evidence);\n      for (const requirementRef of check.requirementRefs ?? []) {\n        const refs = byRequirement.get(requirementRef) ?? []; refs.push(evidence.id); byRequirement.set(requirementRef, refs);\n      }\n    }\n    return byRequirement;\n  }\n\n'''
s=s[:start]+replacement+s[end:]
# replace finding to be check-aware and remove old verificationEvidence method if remains
if '  private verificationEvidence(' in s:
    a=s.index('  private verificationEvidence('); b=s.index('  private verificationFinding', a); s=s[:a]+s[b:]
oldfind='''      category: "structural",\n      severity: "major",\n      observation: `${artifact.logicalName} failed structural verification`,\n      expected: "Artifact exists, is non-empty, and passes its required verifier profile",\n      requirementRefs: [],'''
newfind='''      category: failedCheck?.category ?? "structural",\n      severity: failedCheck?.priority === "critical" ? "critical" : "major",\n      observation: failedCheck?.detail ?? `${artifact.logicalName} did not pass required verification`,\n      expected: failedCheck ? `Pass required check: ${failedCheck.id}` : "Artifact passes its required verifier profile",\n      requirementRefs: failedCheck?.requirementRefs ?? [],'''
s=s.replace('  private verificationFinding(artifact: Artifact, verification: VerificationResult): Finding {\n    return {', '  private verificationFinding(artifact: Artifact, verification: VerificationResult): Finding {\n    const failedCheck = verification.checkResults.find(check => check.status === "fail" || check.status === "inconclusive");\n    return {')
s=s.replace(oldfind,newfind)
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/runtime/mission-runtime.ts')
s=p.read_text()
s=s.replace('import { BasicFileVerifier } from "../core/verification/basic-file-verifier.ts";', 'import { VerificationPlanner } from "../core/verification/verification-planner.ts";\nimport { VerifierRegistry } from "../core/verification/verifier-registry.ts";\nimport { DeterministicFileCheckExecutor } from "../core/verification/deterministic-file-check-executor.ts";\nimport { HostReviewCheckExecutor } from "../core/verification/host-review-check-executor.ts";\nimport { ProfiledVerifier } from "../core/verification/profiled-verifier.ts";')
s=s.replace('      const verifier = new BasicFileVerifier();', '      const registry = new VerifierRegistry([new DeterministicFileCheckExecutor(), new HostReviewCheckExecutor(options.host)]);\n      const verifier = new ProfiledVerifier(new VerificationPlanner(), registry);')
p.write_text(s)
PY

cat > tests/unit/verification-profile.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerificationPlanner } from "../../src/core/verification/verification-planner.ts";
import { VerifierRegistry } from "../../src/core/verification/verifier-registry.ts";
import { DeterministicFileCheckExecutor } from "../../src/core/verification/deterministic-file-check-executor.ts";
import { ProfiledVerifier } from "../../src/core/verification/profiled-verifier.ts";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { AcceptanceContract, Requirement } from "../../src/core/domain/mission.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mission-verification-")); const path = join(root, "deck.pptx"); writeFileSync(path, "not-empty");
  const artifact: Artifact = { id: "deck", missionId: "m", logicalName: "deck", type: "presentation", version: 1, status: "candidate", uri: path, contentHash: "x", producedByAttemptId: "a", sourceArtifactRefs: [], createdAt: new Date().toISOString() };
  const requirement: Requirement = { id: "r-visual", description: "Deck has strong visual hierarchy", type: "visual", priority: "required", verification: "review", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId: "m", revision: 1, requirements: [requirement], requiredArtifacts: [{ logicalName: "deck", type: "presentation", requirementRefs: [requirement.id] }], requiredValidations: [], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  return { artifact, requirement, contract };
}

test("planner creates a perceptual check for visual review requirements", () => {
  const { artifact, requirement, contract } = fixture();
  const profile = new VerificationPlanner().plan(artifact, { acceptanceContract: contract, requirements: [requirement] });
  assert.ok(profile.checks.some(check => check.method === "perceptual" && check.requirementRefs.includes(requirement.id)));
});

test("required perceptual verification is inconclusive when no capable verifier exists", async () => {
  const { artifact, requirement, contract } = fixture();
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor()]));
  const result = await verifier.verify(artifact, { acceptanceContract: contract, requirements: [requirement] });
  assert.equal(result.overall, "inconclusive");
  assert.equal(result.checkResults.find(check => check.requirementRefs?.includes(requirement.id))?.status, "inconclusive");
});
EOF

cat > tests/integration/typed-verification-assurance.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { ArtifactAssurancePipeline } from "../../src/runtime/orchestration/artifact-assurance-pipeline.ts";
import { ProfiledVerifier } from "../../src/core/verification/profiled-verifier.ts";
import { VerificationPlanner } from "../../src/core/verification/verification-planner.ts";
import { VerifierRegistry } from "../../src/core/verification/verifier-registry.ts";
import { DeterministicFileCheckExecutor } from "../../src/core/verification/deterministic-file-check-executor.ts";
import { HostReviewCheckExecutor } from "../../src/core/verification/host-review-check-executor.ts";
import type { AcceptanceContract, Requirement } from "../../src/core/domain/mission.ts";

function acceptance(missionId: string) {
  const requirement: Requirement = { id: "r-visual", description: "Deck has strong visual hierarchy", type: "visual", priority: "required", verification: "review", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId, revision: 2, requirements: [requirement], requiredArtifacts: [{ logicalName: "deck", type: "presentation", requirementRefs: [requirement.id] }], requiredValidations: [], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  return { requirement, contract };
}

async function prepare(root: string, host: FakeHostAdapter, missionId: string) {
  const runtime = new MissionRuntime({ rootDir: root, host });
  await runtime.controller.createMission(missionId, "make visual deck");
  const { requirement, contract } = acceptance(missionId);
  await runtime.controller.emit(missionId, "acceptance.revised", { revision: 2, contract }, { type: "user" }, `acceptance:${missionId}:2`);
  const workspace = runtime.workspaces.allocate(missionId, "attempt-v"); writeFileSync(join(workspace.root, "deck.pptx"), "ppt-data", "utf8");
  const work = { id: "work-deck", missionId, purpose: "production" as const, objective: "make deck", status: "ready" as const, requirementRefs: [requirement.id], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "deck", type: "presentation", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const envelope = { status: "completed" as const, summary: "deck", outputs: [{ path: "deck.pptx", logicalName: "deck", type: "presentation" as const, requirementRefs: [requirement.id] }], proposedFacts: [], proposedWork: [], warnings: [] };
  return { runtime, requirement, workspace, work, envelope };
}

test("artifact assurance refuses to promote visual requirements when perceptual verifier is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-no-review-")); const host = new FakeHostAdapter();
  const { runtime, requirement, workspace, work, envelope } = await prepare(root, host, "m-no-review");
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor()]));
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier });
  const result = await pipeline.process(work, "attempt-v", workspace.root, envelope);
  assert.equal(result.ok, false);
  assert.equal((await runtime.projections.listRequirements("m-no-review")).find(item => item.id === requirement.id)?.status, "unverified");
  assert.ok((await runtime.projections.listGaps("m-no-review")).some(gap => gap.category === "quality"));
  runtime.close();
});

test("independent host reviewer evidence can satisfy a linked visual requirement", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-review-pass-"));
  const host = new FakeHostAdapter([], { agentResponder: request => {
    const kind = (request.context as any)?.kind;
    if (kind === "verification-review") return { status: "pass", detail: "Hierarchy is clear at presentation scale", confidence: 0.9 };
    return {};
  }});
  const { runtime, requirement, workspace, work, envelope } = await prepare(root, host, "m-review-pass");
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor(), new HostReviewCheckExecutor(host)]));
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier });
  const result = await pipeline.process(work, "attempt-v", workspace.root, envelope);
  assert.equal(result.ok, true);
  const projected = (await runtime.projections.listRequirements("m-review-pass")).find(item => item.id === requirement.id);
  assert.equal(projected?.status, "satisfied");
  assert.ok((projected?.evidenceRefs.length ?? 0) > 0);
  runtime.close();
});
EOF

npm test
npm run smoke
git diff --check
