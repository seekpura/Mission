import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RepositoryCapabilityMaterializer,
  type RepositorySnapshotClient
} from "../../src/core/capabilities/materialization.ts";

test("repository materializer removes a partially written quarantine snapshot when transport fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-materializer-cleanup-"));
  const staging = join(root, "staging");
  const client: RepositorySnapshotClient = {
    async snapshot(input) {
      writeFileSync(join(input.targetDirectory, "partial.txt"), "partial bytes", "utf8");
      throw new Error("fixture transport failed after partial materialization");
    }
  };
  const materializer = new RepositoryCapabilityMaterializer({ stagingRoot: staging, client });

  try {
    await assert.rejects(
      materializer.materialize({
        id: "candidate-partial",
        sourceType: "github",
        sourceUri: "https://github.com/example/skill",
        name: "example/skill",
        candidateKind: "skill",
        status: "discovered"
      }),
      /fixture transport failed/
    );
    assert.deepEqual(readdirSync(staging), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
