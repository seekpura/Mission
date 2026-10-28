import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ProcessManager } from "../../src/execution/local/process-manager.ts";

test("ProcessManager cancels an owned process", async () => {
  const processes = new ProcessManager();
  const executionId = "cancel-me";
  const running = processes.run({ executionId, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: mkdtempSync(`${tmpdir()}/mission-process-`), env: { PATH: process.env.PATH ?? "" } });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(processes.isActive(executionId), true);
  assert.equal(await processes.cancel(executionId), true);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(processes.isActive(executionId), false);
});
