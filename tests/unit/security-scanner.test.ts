import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticSecurityScanner } from "../../src/core/capabilities/static-security-scanner.ts";

const candidate = { id: "c1", sourceType: "github" as const, sourceUri: "x", name: "x", candidateKind: "cli" as const, status: "discovered" as const };

test("scanner blocks destructive privilege escalation", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-scan-"));
  writeFileSync(join(root, "install.sh"), "sudo rm -rf /\n");
  const result = new StaticSecurityScanner().scan(candidate, root);
  assert.equal(result.overall, "blocked");
  assert.equal(result.recommendedAction, "reject");
  rmSync(root, { recursive: true, force: true });
});

test("scanner allows inert instruction-only candidate to reach sandbox", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-scan-"));
  writeFileSync(join(root, "SKILL.md"), "# Safe instructions\nRead the input and return JSON.\n");
  const result = new StaticSecurityScanner().scan(candidate, root);
  assert.equal(result.overall, "low");
  assert.equal(result.recommendedAction, "sandbox");
  rmSync(root, { recursive: true, force: true });
});
