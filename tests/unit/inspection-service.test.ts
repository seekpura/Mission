import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { ArtifactInspectionService } from "../../src/runtime/orchestration/artifact-inspection-service.ts";
import { InspectionProviderRegistry } from "../../src/core/inspection/inspection-registry.ts";
import type { InspectionProvider } from "../../src/core/inspection/inspection-provider.ts";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { VerificationProfile } from "../../src/core/domain/verification.ts";

class EscapingProvider implements InspectionProvider {
  id = "escaping-provider";
  supports(): boolean { return true; }
  async inspect(artifact: Artifact) {
    const outside = join(tmpdir(), `mission-inspection-outside-${Date.now()}.png`);
    writeFileSync(outside, "outside", "utf8");
    return {
      providerId: this.id,
      sourceArtifactRef: `${artifact.id}@${artifact.version}`,
      products: [{ kind: "page-render" as const, path: outside, type: "image" as const }]
    };
  }
}

test("inspection service rejects provider products outside the isolated inspection workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-inspection-safe-"));
  const runtime = new MissionRuntime({ rootDir: root, host: new FakeHostAdapter() });
  await runtime.controller.createMission("m-inspection-safe", "verify presentation safely");
  const sourceFile = join(root, "source.pptx");
  writeFileSync(sourceFile, "ppt", "utf8");
  const source: Artifact = runtime.artifacts.commit({ missionId: "m-inspection-safe", logicalName: "deck", type: "presentation", sourcePath: sourceFile, producedByAttemptId: "attempt-source" });
  await runtime.controller.recordArtifact(source.missionId, source);
  const profile: VerificationProfile = {
    id: "visual-profile",
    artifactType: "presentation",
    checks: [{ id: "visual", description: "inspect render", category: "visual", level: "quality", method: "perceptual", priority: "required", requirementRefs: ["R1"] }]
  };
  const service = new ArtifactInspectionService({ controller: runtime.controller, artifacts: runtime.artifacts, workspaces: runtime.workspaces, registry: new InspectionProviderRegistry([new EscapingProvider()]) });
  await assert.rejects(() => service.prepare(source, profile, [source]), /escapes workspace/);
  const artifacts = await runtime.projections.listArtifacts(source.missionId);
  assert.equal(artifacts.filter(item => item.logicalName.startsWith("__inspection__")).length, 0);
  runtime.close();
});
