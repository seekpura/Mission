import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";
import type { CapabilityDescriptor } from "../../src/core/domain/capability.ts";
import { CodexNativeCapabilityHostAdapter } from "../../src/hosts/codex/codex-native-host-adapter.ts";
import type { HostAdapter, HostAgentEvent } from "../../src/hosts/host-adapter.ts";
import { MissionAgentSkillWorkspaceProjector } from "../../src/runtime/agent-skill-runtime.ts";
import { CapabilityWorkspaceHostAdapter } from "../../src/runtime/capability-context-host-adapter.ts";
import { createMissionRuntime } from "../../src/runtime/bootstrap.ts";

const SKILL_NAME = "verified-source-truth";
const SKILL = [
  "---",
  `name: ${SKILL_NAME}`,
  "description: Verify source truth before finalizing deliverables.",
  "---",
  "# Verified Source Truth",
  "Verify source truth and cite concrete evidence.",
  ""
].join("\n");

const FAKE_CODEX_SKILLS = String.raw`
const { appendFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const logPath = process.env.FAKE_CODEX_SKILL_LOG;
const omitSkill = process.env.FAKE_CODEX_OMIT_SKILL === "1";
let turn = 0;
function log(value) { if (logPath) appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...value }) + "\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function discovered(cwd) {
  const skillPath = join(cwd, ".agents", "skills", "${SKILL_NAME}", "SKILL.md");
  return !omitSkill && existsSync(skillPath)
    ? [{ name: "${SKILL_NAME}", description: "Verify source truth before finalizing deliverables.", path: skillPath, scope: "repo", enabled: true, pluginId: null }]
    : [];
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  log({ method: message.method, params: message.params });
  if (message.method === "initialize" && message.id !== undefined) {
    reply(message.id, { userAgent: "fake-codex-skills" });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "skills/list" && message.id !== undefined) {
    const cwd = message.params?.cwds?.[0] || process.cwd();
    reply(message.id, { data: [{ cwd, skills: discovered(cwd), errors: [] }] });
    return;
  }
  if (message.method === "thread/start" && message.id !== undefined) {
    reply(message.id, { thread: { id: "skill-thread" }, model: "provider-default" });
    return;
  }
  if (message.method === "thread/resume" && message.id !== undefined) {
    reply(message.id, { thread: { id: message.params.threadId }, model: "provider-default" });
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    const id = "turn-" + (++turn);
    reply(message.id, { turn: { id, status: "inProgress" } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: message.params.threadId, turn: { id, status: "completed" } } });
    return;
  }
});
`;

type RpcLog = { pid: number; method: string; params?: Record<string, unknown> };

async function fixture() {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-skill-"));
  const script = join(root, "fake-codex-skill.cjs");
  const log = join(root, "codex-skill.jsonl");
  const activated = join(root, "activated-skill");
  const workspace = join(root, "workspace");
  await mkdir(activated);
  await mkdir(workspace);
  await writeFile(join(activated, "SKILL.md"), SKILL, "utf8");
  await writeFile(script, FAKE_CODEX_SKILLS, "utf8");
  await writeFile(log, "", "utf8");
  return { root, script, log, activated, workspace };
}

function activate(overlay: MissionCapabilityOverlay, missionId: string, activated: string): CapabilityDescriptor {
  const capability: CapabilityDescriptor = {
    id: "acquired:verified-source-truth",
    kind: "skill",
    name: SKILL_NAME,
    description: "Verify source truth before finalizing deliverables.",
    hostNative: false,
    available: true,
    invocationRef: activated,
    permissions: [],
    revision: "pinned-revision",
    scope: "mission"
  };
  overlay.activate(missionId, capability);
  return capability;
}

function adapter(input: { script: string; log: string; overlay: MissionCapabilityOverlay; omitSkill?: boolean }): HostAdapter {
  const base = new CodexNativeCapabilityHostAdapter({
    binary: process.execPath,
    argsPrefix: [input.script],
    env: {
      ...process.env,
      FAKE_CODEX_SKILL_LOG: input.log,
      ...(input.omitSkill ? { FAKE_CODEX_OMIT_SKILL: "1" } : {})
    },
    nativeDiscovery: false
  });
  return new CapabilityWorkspaceHostAdapter(
    base,
    new MissionAgentSkillWorkspaceProjector(input.overlay)
  );
}

async function collect(host: HostAdapter, handle: { id: string; nativeRef?: string }): Promise<HostAgentEvent[]> {
  const events: HostAgentEvent[] = [];
  for await (const event of host.observeAgent(handle)) events.push(event);
  return events;
}

async function rows(path: string): Promise<RpcLog[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as RpcLog);
}

function assertSkillVerificationBefore(logRows: RpcLog[], terminalMethod: "thread/start" | "thread/resume") {
  const listIndex = logRows.findIndex(row => row.method === "skills/list");
  const threadIndex = logRows.findIndex(row => row.method === terminalMethod);
  assert.ok(listIndex >= 0, "Codex must verify native repo-skill discovery");
  assert.ok(threadIndex > listIndex, `${terminalMethod} must not run before provider skill acknowledgement`);
  assert.equal(logRows[listIndex]?.params?.forceReload, true);
}

test("Codex create projects only authorized Mission Skill and verifies provider discovery before thread/start", async () => {
  const { root, script, log, activated, workspace } = await fixture();
  const missionId = "mission-codex-skill-create";
  const overlay = new MissionCapabilityOverlay();
  const capability = activate(overlay, missionId, activated);
  const host = adapter({ script, log, overlay });

  try {
    const handle = await host.createAgent({
      missionId,
      workItemId: "work-codex-skill",
      workspaceRoot: workspace,
      allowedCapabilityRefs: [capability.id],
      context: { objective: "use verified source truth" }
    });
    assert((await collect(host, handle)).some(event => event.type === "completed"));

    const logRows = await rows(log);
    assertSkillVerificationBefore(logRows, "thread/start");
    assert.equal(await readFile(join(workspace, ".agents", "skills", SKILL_NAME, "SKILL.md"), "utf8"), SKILL);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex cross-process resume rebuilds and re-verifies the authorized Skill before thread/resume", async () => {
  const { root, script, log, activated, workspace } = await fixture();
  const missionId = "mission-codex-skill-resume";
  const overlay = new MissionCapabilityOverlay();
  const capability = activate(overlay, missionId, activated);

  try {
    const first = adapter({ script, log, overlay });
    const handle = await first.createAgent({
      missionId,
      workItemId: "work-codex-skill-resume",
      workspaceRoot: workspace,
      allowedCapabilityRefs: [capability.id],
      context: { objective: "start with skill" }
    });
    await collect(first, handle);
    await writeFile(log, "", "utf8");

    const recovered = adapter({ script, log, overlay });
    const result = await recovered.resumeAgent({
      missionId,
      workItemId: "work-codex-skill-resume",
      workspaceRoot: workspace,
      allowedCapabilityRefs: [capability.id],
      context: { objective: "recover with the same skill" },
      handleId: handle.id,
      nativeRef: handle.nativeRef!
    });
    assert.equal(result.status, "resumed");
    if (result.status !== "resumed") return;
    await collect(recovered, result.handle);

    assertSkillVerificationBefore(await rows(log), "thread/resume");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex fails closed before thread/start when provider does not acknowledge the projected Skill", async () => {
  const { root, script, log, activated, workspace } = await fixture();
  const missionId = "mission-codex-skill-missing";
  const overlay = new MissionCapabilityOverlay();
  const capability = activate(overlay, missionId, activated);
  const host = adapter({ script, log, overlay, omitSkill: true });

  try {
    await assert.rejects(() => host.createAgent({
      missionId,
      workItemId: "work-codex-skill-missing",
      workspaceRoot: workspace,
      allowedCapabilityRefs: [capability.id],
      context: { objective: "must fail before work" }
    }), /skill|provider|discover/i);
    assert.equal((await rows(log)).some(row => row.method === "thread/start"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production bootstrap permits Codex Agent Skill acquisition only through the provider-native delivery path", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-skill-bootstrap-"));
  const runtime = createMissionRuntime({
    rootDir: root,
    dbPath: join(root, "mission.db"),
    schemaPath: join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"),
    hostKind: "codex",
    codexBinary: process.execPath,
    capabilityAcquisition: {
      mode: "github-skills",
      isolation: "docker",
      dockerImage: "unused-until-acquisition"
    }
  });
  try {
    assert.equal((await runtime.host.describeHost()).type, "openai-codex");
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
