#!/usr/bin/env bash
set -euo pipefail
mkdir -p src/core/verification tests/integration tests/unit

python - <<'PY'
from pathlib import Path
p=Path('src/core/domain/mission.ts')
s=p.read_text()
s=s.replace('export interface RequiredValidation {\n  id: string;\n  description: string;\n  level?: "structural" | "functional" | "quality" | "integration" | "mission";\n  requirementRefs: string[];\n}', '''export interface RequiredValidation {\n  id: string;\n  description: string;\n  level?: "structural" | "functional" | "quality" | "integration" | "mission";\n  requirementRefs: string[];\n  runtime?: {\n    command: string;\n    args?: string[];\n    timeoutMs?: number;\n    env?: Record<string, string>;\n  };\n  integration?: {\n    mode: "artifacts-present";\n    artifactLogicalNames: string[];\n  };\n}''')
p.write_text(s)

p=Path('src/core/domain/verification.ts')
s=p.read_text()
s=s.replace('  requirementRefs: string[];\n}', '''  requirementRefs: string[];\n  config?: {\n    runtime?: { command: string; args?: string[]; timeoutMs?: number; env?: Record<string, string> };\n    integration?: { mode: "artifacts-present"; artifactLogicalNames: string[] };\n  };\n}''', 1)
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/core/verification/check-executor.ts')
s=p.read_text()
s=s.replace('export interface VerificationCheckExecutorContext {\n  missionId: string;\n}', 'export interface VerificationCheckExecutorContext {\n  missionId: string;\n  artifacts?: Artifact[];\n}')
s=s.replace('import type { Artifact } from "../domain/artifact.ts";', 'import type { Artifact } from "../domain/artifact.ts";')
p.write_text(s)

p=Path('src/core/verification/verifier.ts')
s=p.read_text()
s=s.replace('import type { Artifact } from "../domain/artifact.ts";', 'import type { Artifact } from "../domain/artifact.ts";')
s=s.replace('  explicitRequirementRefs?: string[];\n}', '  explicitRequirementRefs?: string[];\n  artifacts?: Artifact[];\n}')
p.write_text(s)

p=Path('src/core/verification/profiled-verifier.ts')
s=p.read_text()
s=s.replace('      results.push(await executor.execute(artifact, check, { missionId: artifact.missionId }));', '      results.push(await executor.execute(artifact, check, { missionId: artifact.missionId, artifacts: context.artifacts }));')
p.write_text(s)
PY

cat > src/core/verification/runtime-command-check-executor.ts <<'EOF'
import { dirname } from "node:path";
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";
import type { VerificationCheckExecutor, VerificationCheckExecutorContext } from "./check-executor.ts";
import { ProcessManager } from "../../execution/local/process-manager.ts";

export class RuntimeCommandCheckExecutor implements VerificationCheckExecutor {
  id = "runtime-command-checks";
  private readonly processes: ProcessManager;
  constructor(processes = new ProcessManager()) { this.processes = processes; }

  supports(check: VerificationCheck): boolean {
    return check.method === "runtime" && typeof check.config?.runtime?.command === "string" && check.config.runtime.command.length > 0;
  }

  async execute(artifact: Artifact, check: VerificationCheck, _context: VerificationCheckExecutorContext): Promise<VerificationCheckResult> {
    const spec = check.config!.runtime!;
    const cwd = dirname(artifact.uri);
    const args = (spec.args ?? []).map(value => substitute(value, artifact));
    const result = await this.processes.run({
      executionId: `verify:${artifact.missionId}:${artifact.id}:${artifact.version}:${check.id}`,
      command: substitute(spec.command, artifact),
      args,
      cwd,
      env: { PATH: process.env.PATH ?? "", ...(spec.env ?? {}) },
      timeoutMs: clampTimeout(spec.timeoutMs)
    });
    const status: VerificationCheckResult["status"] = result.cancelled || result.timedOut || result.exitCode !== 0 ? "fail" : "pass";
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(-2000);
    const detail = status === "pass"
      ? output || `Runtime validation exited successfully with code ${String(result.exitCode)}`
      : result.timedOut ? "Runtime validation timed out"
        : result.cancelled ? "Runtime validation was cancelled"
          : `Runtime validation exited with code ${String(result.exitCode)}${output ? `: ${output}` : ""}`;
    return checkResult(check, status, detail);
  }
}

function substitute(value: string, artifact: Artifact): string {
  return value.replaceAll("{artifact}", artifact.uri).replaceAll("{artifactDir}", dirname(artifact.uri));
}
function clampTimeout(value?: number): number {
  if (!Number.isFinite(value)) return 30000;
  return Math.max(1000, Math.min(120000, Number(value)));
}
function checkResult(check: VerificationCheck, status: VerificationCheckResult["status"], detail: string): VerificationCheckResult {
  return { id: check.id, status, detail, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs };
}
EOF

cat > src/core/verification/integration-check-executor.ts <<'EOF'
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";
import type { VerificationCheckExecutor, VerificationCheckExecutorContext } from "./check-executor.ts";

export class IntegrationCheckExecutor implements VerificationCheckExecutor {
  id = "deterministic-integration-checks";
  supports(check: VerificationCheck): boolean {
    return check.method === "integration" && check.config?.integration?.mode === "artifacts-present";
  }

  async execute(_artifact: Artifact, check: VerificationCheck, context: VerificationCheckExecutorContext): Promise<VerificationCheckResult> {
    const required = check.config!.integration!.artifactLogicalNames;
    const artifacts = context.artifacts ?? [];
    const present = new Set(artifacts.filter(artifact => !["working", "invalid", "superseded"].includes(artifact.status)).map(artifact => artifact.logicalName));
    const missing = required.filter(name => !present.has(name));
    return checkResult(check, missing.length === 0 ? "pass" : "fail", missing.length === 0
      ? `Required integration artifacts are present: ${required.join(", ")}`
      : `Missing integration artifacts: ${missing.join(", ")}`);
  }
}

function checkResult(check: VerificationCheck, status: VerificationCheckResult["status"], detail: string): VerificationCheckResult {
  return { id: check.id, status, detail, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs };
}
EOF

python - <<'PY'
from pathlib import Path
p=Path('src/core/verification/verification-planner.ts')
s=p.read_text()
# replace requirement loop with covering-validation-aware version
old='''    for (const requirement of linked) {\n      const method = methodForRequirement(requirement);\n      if (method === "deterministic") continue;\n      checks.push(check(\n        `requirement-${requirement.id}`,\n        requirement.description,\n        categoryForRequirement(requirement),\n        levelForRequirement(requirement),\n        method,\n        requirement.priority,\n        [requirement.id]\n      ));\n    }'''
new='''    for (const requirement of linked) {\n      const method = methodForRequirement(requirement);\n      if (method === "deterministic") continue;\n      const covered = (context.acceptanceContract?.requiredValidations ?? []).some(validation =>\n        validation.requirementRefs.includes(requirement.id) && methodForValidation(validation.level ?? "quality", artifact.type) === method\n      );\n      if (covered) continue;\n      checks.push(check(\n        `requirement-${requirement.id}`,\n        requirement.description,\n        categoryForRequirement(requirement),\n        levelForRequirement(requirement),\n        method,\n        requirement.priority,\n        [requirement.id]\n      ));\n    }'''
if old not in s: raise SystemExit('requirement loop not found')
s=s.replace(old,new)
old2='''      checks.push(check(\n        `validation-${validation.id}`,\n        validation.description,\n        level === "integration" ? "integration" : level === "functional" ? "functional" : "technical",\n        level,\n        methodForValidation(level, artifact.type),\n        "required",\n        refs\n      ));'''
new2='''      checks.push(check(\n        `validation-${validation.id}`,\n        validation.description,\n        level === "integration" ? "integration" : level === "functional" ? "functional" : "technical",\n        level,\n        methodForValidation(level, artifact.type),\n        "required",\n        refs,\n        { runtime: validation.runtime, integration: validation.integration }\n      ));'''
if old2 not in s: raise SystemExit('validation check block not found')
s=s.replace(old2,new2)
s=s.replace('function check(id: string, description: string, category: VerificationCheck["category"], level: VerificationCheck["level"], method: VerificationMethod, priority: VerificationCheck["priority"], requirementRefs: string[]): VerificationCheck {\n  return { id, description, category, level, method, priority, requirementRefs };\n}', 'function check(id: string, description: string, category: VerificationCheck["category"], level: VerificationCheck["level"], method: VerificationMethod, priority: VerificationCheck["priority"], requirementRefs: string[], config?: VerificationCheck["config"]): VerificationCheck {\n  return { id, description, category, level, method, priority, requirementRefs, config };\n}')
s=s.replace('const key = `${check.id}:${check.method}:${check.requirementRefs.join(",")}`;', 'const key = `${check.id}:${check.method}:${check.requirementRefs.join(",")}:${JSON.stringify(check.config ?? {})}`;')
s=s.replace('for (const char of checks.map(check => `${check.id}:${check.method}:${check.priority}`).sort().join("|")) {', 'for (const char of checks.map(check => `${check.id}:${check.method}:${check.priority}:${JSON.stringify(check.config ?? {})}`).sort().join("|")) {')
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/runtime/orchestration/artifact-assurance-pipeline.ts')
s=p.read_text()
s=s.replace('      const verification = await this.verifier.verify(artifact, { acceptanceContract: contract, requirements, explicitRequirementRefs: output.requirementRefs ?? [] });', '      const missionArtifacts = await this.projections.listArtifacts(work.missionId);\n      const verification = await this.verifier.verify(artifact, { acceptanceContract: contract, requirements, explicitRequirementRefs: output.requirementRefs ?? [], artifacts: missionArtifacts });')
p.write_text(s)

p=Path('src/runtime/mission-runtime.ts')
s=p.read_text()
s=s.replace('import { HostReviewCheckExecutor } from "../core/verification/host-review-check-executor.ts";', 'import { HostReviewCheckExecutor } from "../core/verification/host-review-check-executor.ts";\nimport { RuntimeCommandCheckExecutor } from "../core/verification/runtime-command-check-executor.ts";\nimport { IntegrationCheckExecutor } from "../core/verification/integration-check-executor.ts";')
s=s.replace('const registry = new VerifierRegistry([new DeterministicFileCheckExecutor(), new HostReviewCheckExecutor(options.host)]);', 'const registry = new VerifierRegistry([new DeterministicFileCheckExecutor(), new RuntimeCommandCheckExecutor(), new IntegrationCheckExecutor(), new HostReviewCheckExecutor(options.host)]);')
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/core/acceptance/acceptance-evaluator.ts')
s=p.read_text()
old='''    const passedVerificationIds = new Set(\n      input.verifications\n        .filter(v => v.overall === "pass" || v.overall === "pass_with_warnings")\n        .flatMap(v => [v.id, v.verificationProfileId, v.level])\n    );\n    const missingValidations = contract.requiredValidations\n      .filter(validation => {\n        if (passedVerificationIds.has(validation.id) || passedVerificationIds.has(validation.level ?? "")) return false;\n        return !requirements.some(req =>\n          validation.requirementRefs.includes(req.id)\n          && req.status === "satisfied"\n          && req.evidenceRefs.some(ref => supportingEvidence.has(ref))\n        );\n      })'''
new='''    const missingValidations = contract.requiredValidations\n      .filter(validation => {\n        const exactCheckPassed = input.verifications.some(result =>\n          result.checkResults.some(check => check.id === `validation-${validation.id}` && check.status === "pass")\n        );\n        if (exactCheckPassed) return false;\n        return !requirements.some(req =>\n          validation.requirementRefs.includes(req.id)\n          && req.status === "satisfied"\n          && req.evidenceRefs.some(ref => supportingEvidence.has(ref))\n        );\n      })'''
if old not in s: raise SystemExit('acceptance validation block not found')
s=s.replace(old,new)
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/core/planning/host-deliberation-provider.ts')
s=p.read_text()
s=s.replace('"requiredValidations":[{"id":string,"description":string,"level":"structural|functional|quality|integration|mission","requirementRefs":string[]}],', '"requiredValidations":[{"id":string,"description":string,"level":"structural|functional|quality|integration|mission","requirementRefs":string[],"runtime"?:{"command":string,"args":string[],"timeoutMs":number},"integration"?:{"mode":"artifacts-present","artifactLogicalNames":string[]}}],')
s=s.replace('Create an acceptance contract that captures the actual end goal, not implementation steps. Critical/required requirements must be objectively checkable. Use stable short ids. Do not invent extra deliverables the user did not request.', 'Create an acceptance contract that captures the actual end goal, not implementation steps. Critical/required requirements must be objectively checkable. Use stable short ids. Do not invent extra deliverables the user did not request. For functional/runtime validation, include runtime only when a concrete direct executable and argument vector can be stated; never use shell pipelines, redirection, or command strings containing multiple commands. For integration checks that only require presence of named artifacts, use integration.mode=artifacts-present.')
old='''    const requiredValidations: RequiredValidation[] = arrayValue(rawContract.requiredValidations).map((raw: any, index) => ({\n      id: stringValue(raw?.id, `validation-${index + 1}`),\n      description: stringValue(raw?.description, `Validate mission output ${index + 1}`),\n      level: validationLevel(raw?.level),\n      requirementRefs: stringArray(raw?.requirementRefs)\n    }));'''
new='''    const requiredValidations: RequiredValidation[] = arrayValue(rawContract.requiredValidations).map((raw: any, index) => ({\n      id: stringValue(raw?.id, `validation-${index + 1}`),\n      description: stringValue(raw?.description, `Validate mission output ${index + 1}`),\n      level: validationLevel(raw?.level),\n      requirementRefs: stringArray(raw?.requirementRefs),\n      runtime: runtimeValidation(raw?.runtime),\n      integration: integrationValidation(raw?.integration)\n    }));'''
if old not in s: raise SystemExit('required validations parse block missing')
s=s.replace(old,new)
s += '''\nfunction runtimeValidation(value: unknown): RequiredValidation["runtime"] {\n  if (!value || typeof value !== "object") return undefined;\n  const raw = value as any;\n  if (typeof raw.command !== "string" || !raw.command.trim()) return undefined;\n  if (/\\n|\\r|[;&|><`]/.test(raw.command)) return undefined;\n  return { command: raw.command.trim(), args: stringArray(raw.args), timeoutMs: typeof raw.timeoutMs === "number" ? Math.max(1000, Math.min(120000, raw.timeoutMs)) : undefined };\n}\nfunction integrationValidation(value: unknown): RequiredValidation["integration"] {\n  if (!value || typeof value !== "object") return undefined;\n  const raw = value as any;\n  if (raw.mode !== "artifacts-present") return undefined;\n  const artifactLogicalNames = stringArray(raw.artifactLogicalNames);\n  return artifactLogicalNames.length > 0 ? { mode: "artifacts-present", artifactLogicalNames } : undefined;\n}\n'''
p.write_text(s)
PY

cat > tests/integration/runtime-integration-verification.test.ts <<'EOF'
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
import { RuntimeCommandCheckExecutor } from "../../src/core/verification/runtime-command-check-executor.ts";
import { IntegrationCheckExecutor } from "../../src/core/verification/integration-check-executor.ts";
import type { AcceptanceContract, Requirement } from "../../src/core/domain/mission.ts";

function verifier() { return new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor(), new RuntimeCommandCheckExecutor(), new IntegrationCheckExecutor()])); }

async function setupRuntime(missionId: string, contract: AcceptanceContract) {
  const root = mkdtempSync(join(tmpdir(), "mission-runtime-verify-"));
  const runtime = new MissionRuntime({ rootDir: root, host: new FakeHostAdapter() });
  await runtime.controller.createMission(missionId, contract.requirements[0]?.description ?? "verify");
  await runtime.controller.emit(missionId, "acceptance.revised", { revision: contract.revision, contract }, { type: "user" }, `acceptance:${missionId}:${contract.revision}`);
  return { root, runtime };
}

test("runtime validation executes a structured command and satisfies a test-backed requirement", async () => {
  const missionId = "runtime-validation-pass";
  const requirement: Requirement = { id: "r-test", description: "Program executes successfully", type: "functional", priority: "required", verification: "test", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId, revision: 2, requirements: [requirement], requiredArtifacts: [{ logicalName: "program", type: "code", requirementRefs: [requirement.id] }], requiredValidations: [{ id: "run-program", description: "Run generated program", level: "functional", requirementRefs: [requirement.id], runtime: { command: process.execPath, args: ["{artifact}"] } }], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  const { runtime } = await setupRuntime(missionId, contract);
  const workspace = runtime.workspaces.allocate(missionId, "attempt-runtime");
  writeFileSync(join(workspace.root, "program.mjs"), "process.exit(0);", "utf8");
  const work = { id: "work-program", missionId, purpose: "production" as const, objective: "build program", status: "ready" as const, requirementRefs: [requirement.id], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "program", type: "code", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const envelope = { status: "completed" as const, summary: "program", outputs: [{ path: "program.mjs", logicalName: "program", type: "code" as const, requirementRefs: [requirement.id] }], proposedFacts: [], proposedWork: [], warnings: [] };
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier: verifier() });
  const result = await pipeline.process(work, "attempt-runtime", workspace.root, envelope);
  assert.equal(result.ok, true);
  assert.equal((await runtime.projections.listRequirements(missionId)).find(item => item.id === requirement.id)?.status, "satisfied");
  assert.ok((await runtime.projections.listVerificationResults(missionId)).some(item => item.checkResults.some(check => check.id === "validation-run-program" && check.status === "pass")));
  runtime.close();
});

test("failing runtime validation creates a blocking artifact gap and leaves requirement unverified", async () => {
  const missionId = "runtime-validation-fail";
  const requirement: Requirement = { id: "r-test", description: "Program executes successfully", type: "functional", priority: "required", verification: "test", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId, revision: 2, requirements: [requirement], requiredArtifacts: [{ logicalName: "program", type: "code", requirementRefs: [requirement.id] }], requiredValidations: [{ id: "run-program", description: "Run generated program", level: "functional", requirementRefs: [requirement.id], runtime: { command: process.execPath, args: ["{artifact}"] } }], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  const { runtime } = await setupRuntime(missionId, contract);
  const workspace = runtime.workspaces.allocate(missionId, "attempt-runtime-fail");
  writeFileSync(join(workspace.root, "program.mjs"), "process.exit(3);", "utf8");
  const work = { id: "work-program", missionId, purpose: "production" as const, objective: "build program", status: "ready" as const, requirementRefs: [requirement.id], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "program", type: "code", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const envelope = { status: "completed" as const, summary: "program", outputs: [{ path: "program.mjs", logicalName: "program", type: "code" as const, requirementRefs: [requirement.id] }], proposedFacts: [], proposedWork: [], warnings: [] };
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier: verifier() });
  const result = await pipeline.process(work, "attempt-runtime-fail", workspace.root, envelope);
  assert.equal(result.ok, false);
  assert.equal((await runtime.projections.listRequirements(missionId)).find(item => item.id === requirement.id)?.status, "unverified");
  assert.ok((await runtime.projections.listGaps(missionId)).some(gap => gap.category === "quality" && gap.status === "open"));
  runtime.close();
});

test("integration validation verifies specifically named artifacts and AcceptanceEvaluator requires the exact validation check", async () => {
  const missionId = "integration-validation";
  const requirement: Requirement = { id: "r-bundle", description: "Bundle artifact exists", type: "functional", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId, revision: 2, requirements: [requirement], requiredArtifacts: [{ logicalName: "bundle", type: "document", requirementRefs: [requirement.id] }, { logicalName: "manifest", type: "document", requirementRefs: [] }], requiredValidations: [{ id: "bundle-pair", description: "Bundle and manifest are both present", level: "integration", requirementRefs: [], integration: { mode: "artifacts-present", artifactLogicalNames: ["bundle", "manifest"] } }], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  const { runtime } = await setupRuntime(missionId, contract);
  const manifestWorkspace = runtime.workspaces.allocate(missionId, "attempt-manifest");
  writeFileSync(join(manifestWorkspace.root, "manifest.md"), "manifest", "utf8");
  const manifestArtifact = runtime.artifacts.commit({ missionId, logicalName: "manifest", type: "document", sourcePath: join(manifestWorkspace.root, "manifest.md"), producedByAttemptId: "attempt-manifest" });
  await runtime.controller.recordArtifact(missionId, manifestArtifact);
  await runtime.controller.validateArtifact(missionId, `${manifestArtifact.id}@${manifestArtifact.version}`, true);

  const workspace = runtime.workspaces.allocate(missionId, "attempt-bundle"); writeFileSync(join(workspace.root, "bundle.md"), "bundle", "utf8");
  const work = { id: "work-bundle", missionId, purpose: "integration" as const, objective: "integrate bundle", status: "ready" as const, requirementRefs: [requirement.id], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "bundle", type: "document", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const envelope = { status: "completed" as const, summary: "bundle", outputs: [{ path: "bundle.md", logicalName: "bundle", type: "document" as const, requirementRefs: [requirement.id] }], proposedFacts: [], proposedWork: [], warnings: [] };
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier: verifier() });
  const result = await pipeline.process(work, "attempt-bundle", workspace.root, envelope);
  assert.equal(result.ok, true);
  const evaluation = await runtime.controller.acceptanceEvaluation(missionId);
  assert.equal(evaluation.missingValidations.includes("bundle-pair"), false);
  runtime.close();
});
EOF

cat > tests/unit/acceptance-validation-specificity.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { AcceptanceEvaluator } from "../../src/core/acceptance/acceptance-evaluator.ts";
import type { AcceptanceContract } from "../../src/core/domain/mission.ts";

 test("AcceptanceEvaluator does not let one integration-level PASS satisfy a different validation", () => {
  const contract: AcceptanceContract = { missionId: "m", revision: 1, requirements: [], requiredArtifacts: [], requiredValidations: [
    { id: "integration-a", description: "A", level: "integration", requirementRefs: [] },
    { id: "integration-b", description: "B", level: "integration", requirementRefs: [] }
  ], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  const result = new AcceptanceEvaluator().evaluate({ contract, requirements: [], artifacts: [], evidence: [], verifications: [{ id: "v", missionId: "m", artifactRef: "a@1", verificationProfileId: "p", verifierId: "x", level: "integration", overall: "pass", checkResults: [{ id: "validation-integration-a", status: "pass", evidenceRefs: [] }], findingRefs: [], evidenceRefs: [], createdAt: new Date().toISOString() }] });
  assert.deepEqual(result.missingValidations, ["integration-b"]);
});
EOF

npm test
npm run smoke
git diff --check
