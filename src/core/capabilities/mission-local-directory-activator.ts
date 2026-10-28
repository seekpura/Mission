import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityCandidate, CapabilityDescriptor, CapabilityNeed, SecurityAssessment } from "../domain/capability.ts";
import type { MaterializedCapability } from "./materialization.ts";

export interface MaterializedActivationInput {
  candidate: CapabilityCandidate;
  need: CapabilityNeed;
  materialized: MaterializedCapability;
  sandboxRoot: string;
  security: SecurityAssessment;
}

export interface MaterializedCapabilityActivator {
  activate(input: MaterializedActivationInput): Promise<CapabilityDescriptor>;
}

/**
 * Copies an already scanned and smoke-verified sandbox snapshot into a durable
 * mission-local capability directory. Activation never mutates host-global
 * capability directories.
 */
export class MissionLocalDirectoryActivator implements MaterializedCapabilityActivator {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  async activate(input: MaterializedActivationInput): Promise<CapabilityDescriptor> {
    const revisionSegment = safeSegment(input.materialized.resolvedRevision || input.materialized.contentHash);
    const destination = join(
      this.root,
      safeSegment(input.need.missionId),
      safeSegment(input.candidate.id),
      revisionSegment
    );

    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    cpSync(input.sandboxRoot, destination, { recursive: true, dereference: false });

    return {
      id: `acquired:${input.candidate.id}`,
      kind: input.candidate.candidateKind,
      name: input.candidate.name,
      description: input.candidate.description ?? `Mission-local capability acquired from ${input.candidate.sourceUri}`,
      hostNative: false,
      available: true,
      invocationRef: destination,
      permissions: [...input.security.requestedPermissions],
      revision: input.materialized.resolvedRevision,
      scope: "mission"
    };
  }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "capability";
}
