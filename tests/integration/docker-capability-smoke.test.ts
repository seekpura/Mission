import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerSmokeExecutor } from "../../src/runtime/agent-skill-runtime.ts";

test("Docker capability smoke uses no-network read-only least-privilege flags and never pulls", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-docker-smoke-"));
  const argsFile = join(root, "docker-args.txt");
  const fakeDocker = join(root, "fake-docker.sh");
  const candidate = join(root, "candidate");
  await import("node:fs/promises").then(fs => fs.mkdir(candidate));
  await writeFile(fakeDocker, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`, "utf8");
  await chmod(fakeDocker, 0o755);

  try {
    const executor = new DockerSmokeExecutor({
      image: "mission-smoke:test",
      binary: fakeDocker,
      timeoutMs: 5_000
    });
    const result = await executor.execute({
      cwd: candidate,
      command: "/bin/sh",
      args: ["-c", "test -s SKILL.md"],
      env: {}
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);

    const args = (await readFile(argsFile, "utf8")).split("\n").filter(Boolean);
    assert.equal(args[0], "run");
    assert.ok(args.includes("--rm"));
    assert.ok(args.includes("--pull=never"));
    assert.ok(args.includes("--network=none"));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--cap-drop=ALL"));
    assert.ok(args.includes("--security-opt=no-new-privileges"));
    assert.ok(args.includes("--user"));
    assert.ok(args.includes("65534:65534"));
    assert.ok(args.some(value => value.startsWith("--pids-limit=")));
    assert.ok(args.some(value => value.startsWith("--memory=")));
    assert.ok(args.some(value => value.startsWith("--cpus=")));
    assert.ok(args.includes("mission-smoke:test"));
    assert.ok(args.includes("/bin/sh"));
    assert.equal(args.includes("--privileged"), false);
    const volumeIndex = args.indexOf("--volume");
    assert.ok(volumeIndex >= 0);
    assert.match(args[volumeIndex + 1] ?? "", /:\/workspace:ro$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
