import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityDescriptor, CapabilityNeed, RiskLevel, SecurityAssessment } from "../domain/capability.ts";
import type { PolicyDecision } from "../policy/policy-engine.ts";
import type { CapabilitySmokeResult } from "./sandbox/isolated-smoke-runner.ts";

export type AcquisitionReceiptStatus =
  | "rejected"
  | "approval_rejected"
  | "smoke_failed"
  | "activation_failed"
  | "activated"
  | "activated_from_trusted_cache";

export interface AcquisitionReceipt {
  id: string;
  missionId: string;
  capabilityNeedId: string;
  candidateId: string;
  sourceType: string;
  sourceUri: string;
  resolvedRevision: string;
  contentHash: string;
  allowedRisk: RiskLevel;
  security: SecurityAssessment;
  policy: PolicyDecision;
  approval?: { approved: boolean; actor?: string; decidedAt: string };
  smoke?: CapabilitySmokeResult;
  cache?: {
    status: "miss" | "reused" | "stored" | "store_failed" | "lookup_failed";
    cacheKey?: string;
    reason?: string;
  };
  activatedCapability?: CapabilityDescriptor;
  status: AcquisitionReceiptStatus;
  reason?: string;
  createdAt: string;
}

export interface AcquisitionReceiptStore {
  save(receipt: AcquisitionReceipt): Promise<void> | void;
  list(missionId: string): Promise<AcquisitionReceipt[]> | AcquisitionReceipt[];
}

export class FileAcquisitionReceiptStore implements AcquisitionReceiptStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  save(receipt: AcquisitionReceipt): void {
    const dir = join(this.root, safeSegment(receipt.missionId));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${safeSegment(receipt.id)}.json`);
    writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }

  list(missionId: string): AcquisitionReceipt[] {
    const dir = join(this.root, safeSegment(missionId));
    let names: string[];
    try {
      names = readdirSync(dir).filter(name => name.endsWith(".json")).sort();
    } catch {
      return [];
    }
    return names.map(name => JSON.parse(readFileSync(join(dir, name), "utf8")) as AcquisitionReceipt);
  }
}

export function acquisitionNeedSnapshot(need: CapabilityNeed) {
  return {
    missionId: need.missionId,
    capabilityNeedId: need.id,
    allowedRisk: need.maxRisk
  };
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "receipt";
}
