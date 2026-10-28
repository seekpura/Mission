import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("generic core, runtime and execution modules do not import HostAdapter through a provider namespace", () => {
  const roots = [
    join(process.cwd(), "src", "core"),
    join(process.cwd(), "src", "runtime"),
    join(process.cwd(), "src", "execution")
  ];
  const violations: string[] = [];
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const content = readFileSync(file, "utf8");
      if (content.includes("hosts/deepseek/host-adapter.ts")) {
        violations.push(relative(process.cwd(), file));
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Provider-specific HostAdapter contract imports remain in generic source: ${violations.join(", ")}`
  );
});
