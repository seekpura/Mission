import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";

test("artifact store versions immutable committed artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-artifacts-"));
  const src = join(root, "source.txt");
  const store = new FileArtifactStore(root);
  writeFileSync(src, "v1");
  const a = store.commit({ missionId: "m", logicalName: "report", type: "document", sourcePath: src, producedByAttemptId: "a1" });
  writeFileSync(src, "v2");
  const b = store.commit({ missionId: "m", logicalName: "report", type: "document", sourcePath: src, producedByAttemptId: "a2" });
  assert.equal(a.version, 1);
  assert.equal(b.version, 2);
  assert.notEqual(a.contentHash, b.contentHash);
  rmSync(root, { recursive: true, force: true });
});
