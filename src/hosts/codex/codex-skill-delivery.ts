import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentCreateRequest } from "../host-adapter.ts";

const PROJECTION_RECEIPT = ".mission-skill-projection.json";
const SKILL_ROOT_SEGMENTS = [".agents", "skills"] as const;
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_SKILLS = 64;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

interface ProjectionReceipt {
  missionId: string;
  capabilities: ProjectionEntry[];
}

interface ProjectionEntry {
  capabilityId: string;
  skillName: string;
  revision?: string;
  contentHash: string;
  workspacePath: string;
}

export interface CodexSkillDelivery {
  root: string;
  expected: Array<{
    capabilityId: string;
    name: string;
    skillPath: string;
    contentHash: string;
  }>;
}

/**
 * Re-validates the Runtime-owned attempt-local Agent Skill projection before a
 * Codex provider process is allowed to consume it. The projection receipt is
 * diagnostic metadata, not authority: every expected SKILL.md path and hash is
 * checked against the concrete workspace bytes and the Work's authorized refs.
 */
export function resolveCodexSkillDelivery(request: AgentCreateRequest): CodexSkillDelivery | undefined {
  const acquiredRefs = [...new Set(request.allowedCapabilityRefs.filter(ref => ref.startsWith("acquired:")))].sort();
  if (!request.workspaceRoot) {
    if (acquiredRefs.length > 0) throw new Error("Codex Agent Skill delivery requires an explicit workspaceRoot");
    return undefined;
  }

  const workspace = realDirectory(request.workspaceRoot, "Codex skill workspace");
  const receiptPath = join(workspace, PROJECTION_RECEIPT);
  if (!existsSync(receiptPath)) {
    if (acquiredRefs.length > 0) throw new Error("Codex Agent Skill projection receipt is missing");
    return undefined;
  }
  const receiptInfo = lstatSync(receiptPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) throw new Error("Codex Agent Skill projection receipt must be a regular file");
  if (receiptInfo.size <= 0 || receiptInfo.size > MAX_RECEIPT_BYTES) {
    throw new Error(`Codex Agent Skill projection receipt size is outside 1..${MAX_RECEIPT_BYTES}`);
  }

  const parsed = parseReceipt(readFileSync(receiptPath, "utf8"));
  if (parsed.missionId !== request.missionId) {
    throw new Error(`Codex Agent Skill projection Mission mismatch: ${parsed.missionId} != ${request.missionId}`);
  }
  if (parsed.capabilities.length > MAX_SKILLS) throw new Error(`Codex Agent Skill projection exceeds ${MAX_SKILLS} skills`);

  const projectedIds = parsed.capabilities.map(item => item.capabilityId).sort();
  if (!sameStrings(projectedIds, acquiredRefs)) {
    throw new Error("Codex Agent Skill projection does not exactly match authorized acquired capability refs");
  }
  if (parsed.capabilities.length === 0) return undefined;

  const root = realDirectory(join(workspace, ...SKILL_ROOT_SEGMENTS), "Codex Agent Skill projection root");
  assertWithin(workspace, root, "Codex Agent Skill projection root");
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const expected = parsed.capabilities.map(item => {
    if (!item.capabilityId.startsWith("acquired:")) throw new Error(`Codex Skill capability is not acquired: ${item.capabilityId}`);
    if (seenIds.has(item.capabilityId)) throw new Error(`Duplicate Codex Skill capability id: ${item.capabilityId}`);
    seenIds.add(item.capabilityId);
    if (!SKILL_NAME.test(item.skillName)) throw new Error(`Invalid Codex Skill name: ${item.skillName}`);
    if (seenNames.has(item.skillName)) throw new Error(`Duplicate Codex Skill name: ${item.skillName}`);
    seenNames.add(item.skillName);
    if (!SHA256.test(item.contentHash)) throw new Error(`Invalid Codex Skill content hash for ${item.skillName}`);

    const expectedRelative = [...SKILL_ROOT_SEGMENTS, item.skillName, "SKILL.md"].join("/");
    if (item.workspacePath !== expectedRelative) {
      throw new Error(`Codex Skill projection path mismatch for ${item.skillName}: ${item.workspacePath}`);
    }
    const skillPath = join(workspace, ...SKILL_ROOT_SEGMENTS, item.skillName, "SKILL.md");
    if (!existsSync(skillPath)) throw new Error(`Projected Codex Skill is missing: ${item.skillName}`);
    const info = lstatSync(skillPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Projected Codex Skill must be a regular SKILL.md: ${item.skillName}`);
    const realSkillPath = realpathSync(skillPath);
    assertWithin(root, realSkillPath, item.skillName);
    const contentHash = `sha256:${createHash("sha256").update(readFileSync(realSkillPath)).digest("hex")}`;
    if (contentHash !== item.contentHash) throw new Error(`Projected Codex Skill hash mismatch: ${item.skillName}`);
    return {
      capabilityId: item.capabilityId,
      name: item.skillName,
      skillPath: realSkillPath,
      contentHash
    };
  });

  return { root, expected };
}

/**
 * Provider acknowledgement is required before thread start/resume. Codex may
 * also list user/system skills; Mission only requires its exact projected skill
 * name/path pairs to appear enabled and rejects provider discovery errors.
 */
export function assertCodexSkillList(
  value: unknown,
  workspaceRoot: string,
  delivery: CodexSkillDelivery
): void {
  const response = record(value, "Codex skills/list response");
  if (!Array.isArray(response.data)) throw new Error("Codex skills/list response.data must be an array");
  if (response.data.length > 16) throw new Error("Codex skills/list returned too many cwd entries");
  const workspace = resolve(workspaceRoot);
  const matching = response.data
    .map((entry, index) => record(entry, `Codex skills/list data[${index}]`))
    .filter(entry => typeof entry.cwd === "string" && resolve(entry.cwd) === workspace);
  if (matching.length !== 1) throw new Error("Codex skills/list did not return exactly one entry for the Mission workspace");
  const entry = matching[0]!;
  if (!Array.isArray(entry.errors)) throw new Error("Codex skills/list entry.errors must be an array");
  if (entry.errors.length > 0) throw new Error("Codex skills/list reported provider discovery errors for the Mission workspace");
  if (!Array.isArray(entry.skills)) throw new Error("Codex skills/list entry.skills must be an array");
  if (entry.skills.length > 1_024) throw new Error("Codex skills/list returned too many skills");

  const skills = entry.skills.map((item, index) => record(item, `Codex skills/list skill[${index}]`));
  for (const expected of delivery.expected) {
    const matches = skills.filter(skill =>
      skill.name === expected.name &&
      typeof skill.path === "string" &&
      resolve(skill.path) === resolve(expected.skillPath)
    );
    if (matches.length !== 1) {
      throw new Error(`Codex provider did not discover the exact projected Skill ${expected.name}`);
    }
    if (matches[0]!.enabled !== true) throw new Error(`Codex provider reported projected Skill ${expected.name} as disabled`);
  }
}

function parseReceipt(text: string): ProjectionReceipt {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Codex Agent Skill projection receipt is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = record(value, "Codex Agent Skill projection receipt");
  if (typeof object.missionId !== "string" || !object.missionId.trim()) throw new Error("Codex Agent Skill projection receipt requires missionId");
  if (!Array.isArray(object.capabilities)) throw new Error("Codex Agent Skill projection receipt requires capabilities[]");
  const capabilities = object.capabilities.map((item, index) => {
    const entry = record(item, `Codex Agent Skill projection capabilities[${index}]`);
    return {
      capabilityId: stringValue(entry.capabilityId, `capabilities[${index}].capabilityId`),
      skillName: stringValue(entry.skillName, `capabilities[${index}].skillName`),
      ...(typeof entry.revision === "string" && entry.revision.trim() ? { revision: entry.revision.trim() } : {}),
      contentHash: stringValue(entry.contentHash, `capabilities[${index}].contentHash`),
      workspacePath: stringValue(entry.workspacePath, `capabilities[${index}].workspacePath`)
    };
  });
  return { missionId: object.missionId.trim(), capabilities };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`);
  const info = lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${absolute}`);
  const real = realpathSync(absolute);
  if (!statSync(real).isDirectory()) throw new Error(`${label} is not a directory: ${real}`);
  return real;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`Codex Agent Skill path escapes Runtime-owned root: ${label}`);
  }
}
