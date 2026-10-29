import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { createMissionRuntime } from "../../src/runtime/bootstrap.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}

test("synchronous runtime.close cannot race an asynchronous runtime.shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-close-shutdown-guard-"));
  const runtime = createMissionRuntime({
    rootDir: root,
    dbPath: join(root, "mission.db"),
    schemaPath: join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"),
    host: new FakeHostAdapter(),
    executorId: "fake-host"
  });
  const release = deferred();
  const originalWaitForAllIdle = runtime.supervisor.waitForAllIdle.bind(runtime.supervisor);
  runtime.supervisor.waitForAllIdle = async () => {
    await release.promise;
    await originalWaitForAllIdle();
  };

  try {
    const shutdown = runtime.shutdown({ gracefulTimeoutMs: 1_000, forcedTimeoutMs: 1_000 });
    assert.throws(
      () => runtime.close(),
      /Cannot synchronously close Mission Runtime while asynchronous shutdown is in progress/
    );
    release.resolve();
    const result = await shutdown;
    assert.equal(result.forced, false);
  } finally {
    release.resolve();
    rmSync(root, { recursive: true, force: true });
  }
});
