import type { ArtifactType } from "../core/domain/artifact.ts";
import type { CapabilityCostClass, CapabilityDescriptor } from "../core/domain/capability.ts";
import type { Evidence, VerificationEvidenceKind } from "../core/domain/verification.ts";
import type {
  VerificationEvidenceCollector,
  VerificationEvidenceCollectorInput,
  VerificationEvidenceDraft
} from "../core/verification/evidence-collector.ts";
import type { VerificationProfileKind } from "../core/verification/verification-profile.ts";
import type { HostAdapter } from "../hosts/deepseek/host-adapter.ts";

export interface TrustedHostCapabilityEvidenceBinding {
  /** Stable Runtime-owned binding id, not provider-authored. */
  id: string;
  capabilityId: string;
  evidenceKind: VerificationEvidenceKind;
  evidenceType: Evidence["type"];
  profileKinds: VerificationProfileKind[];
  artifactTypes?: ArtifactType[];
  /** Exact semantic function the live capability must advertise. */
  expectedFunction: string;
  /**
   * Must be literally true. invokeHostCapability currently has no Mission
   * side-effect admission envelope, so only operator-declared read-only
   * evidence capabilities are eligible for this adapter.
   */
  readOnly: true;
  /** Exact permission strings accepted as read-only for this binding. */
  allowedPermissions?: string[];
  /** Metered host capabilities are denied unless explicitly allowed. */
  allowMetered?: boolean;
  /** Unknown or above-limit monetary classes fail closed. Defaults to low. */
  maxMonetaryClass?: Exclude<CapabilityCostClass, "unknown">;
  /** Trusted durable claim; host output cannot replace this audit claim. */
  claim: string;
  maxOutputBytes?: number;
}

interface HostEvidenceOutput {
  result: Evidence["result"];
  summary?: string;
  inspectionPayload?: unknown;
}

const RESULT_VALUES = new Set<Evidence["result"]>(["supports", "contradicts", "inconclusive"]);
const COST_RANK: Record<CapabilityCostClass, number> = {
  negligible: 0,
  low: 1,
  medium: 2,
  high: 3,
  unknown: 4
};

/**
 * Explicit bridge from a host-native `invokeHostCapability` route into Runtime
 * Evidence. Nothing is auto-discovered or guessed: a trusted Runtime binding
 * must name the capability, semantic function, evidence kind, supported
 * profiles and read-only permission/cost envelope.
 */
export class TrustedHostCapabilityEvidenceCollector implements VerificationEvidenceCollector {
  readonly id: string;
  readonly kinds: readonly VerificationEvidenceKind[];
  private readonly host: HostAdapter;
  private readonly binding: TrustedHostCapabilityEvidenceBinding;
  private readonly maxOutputBytes: number;

  constructor(host: HostAdapter, binding: TrustedHostCapabilityEvidenceBinding) {
    this.host = host;
    this.binding = validateBinding(binding);
    this.id = `host-evidence:${this.binding.id}`;
    this.kinds = [this.binding.evidenceKind];
    this.maxOutputBytes = Math.max(1_024, Math.min(2 * 1024 * 1024, this.binding.maxOutputBytes ?? 256 * 1024));
  }

  supports(input: VerificationEvidenceCollectorInput): boolean {
    if (!this.binding.profileKinds.includes(input.profile.kind)) return false;
    if (this.binding.artifactTypes && !this.binding.artifactTypes.includes(input.artifact.type)) return false;
    return true;
  }

  async collect(input: VerificationEvidenceCollectorInput): Promise<VerificationEvidenceDraft[]> {
    const snapshot = await this.host.snapshotEnvironment();
    const capability = snapshot.capabilities.find(item => item.id === this.binding.capabilityId);
    if (!capability) throw new Error(`Configured host evidence capability is absent: ${this.binding.capabilityId}`);
    assertCapabilityEligible(capability, this.binding);

    const response = await this.host.invokeHostCapability({
      capabilityId: capability.id,
      input: {
        operation: "mission.verification.collect_evidence",
        evidenceKind: this.binding.evidenceKind,
        missionId: input.artifact.missionId,
        artifact: {
          id: input.artifact.id,
          version: input.artifact.version,
          logicalName: input.artifact.logicalName,
          type: input.artifact.type,
          uri: input.artifact.uri,
          contentHash: input.artifact.contentHash,
          ...(input.artifact.mimeType ? { mimeType: input.artifact.mimeType } : {}),
          ...(input.artifact.sizeBytes === undefined ? {} : { sizeBytes: input.artifact.sizeBytes })
        },
        verificationProfile: {
          id: input.profile.id,
          kind: input.profile.kind
        }
      }
    });
    if (!response.ok) {
      throw new Error(`Host evidence capability ${capability.id} failed: ${response.error ?? "unknown host error"}`);
    }
    const bytes = serializedBytes(response.output);
    if (bytes > this.maxOutputBytes) {
      throw new Error(`Host evidence capability ${capability.id} output exceeds ${this.maxOutputBytes} bytes`);
    }
    const output = normalizeOutput(response.output);
    const sourceRevision = capability.revision ?? capability.provenance?.revision ?? snapshot.revision.toString();
    const sourceRef = `host-capability:${safeSourceSegment(capability.id)}@${safeSourceSegment(sourceRevision)}`;
    const summary = output.summary?.trim();
    const transient = output.inspectionPayload === undefined && !summary
      ? undefined
      : {
          ...(summary ? { summary } : {}),
          ...(output.inspectionPayload === undefined ? {} : { evidence: output.inspectionPayload })
        };

    return [{
      type: this.binding.evidenceType,
      kind: this.binding.evidenceKind,
      claim: this.binding.claim,
      result: output.result,
      sourceRef,
      details: {
        bindingId: this.binding.id,
        capabilityId: capability.id,
        capabilityRevision: sourceRevision,
        semanticFunction: this.binding.expectedFunction,
        hostType: snapshot.host.type,
        ...(snapshot.host.version ? { hostVersion: snapshot.host.version } : {}),
        ...(capability.native?.provider ? { provider: capability.native.provider } : {}),
        ...(capability.native?.nativeId ? { nativeId: capability.native.nativeId } : {})
      },
      ...(transient === undefined ? {} : { inspectionPayload: transient })
    }];
  }
}

export function createTrustedHostCapabilityEvidenceCollectors(
  host: HostAdapter,
  bindings: TrustedHostCapabilityEvidenceBinding[]
): VerificationEvidenceCollector[] {
  const ids = new Set<string>();
  return bindings.map(binding => {
    if (ids.has(binding.id)) throw new Error(`Duplicate host evidence binding id: ${binding.id}`);
    ids.add(binding.id);
    return new TrustedHostCapabilityEvidenceCollector(host, binding);
  });
}

function validateBinding(binding: TrustedHostCapabilityEvidenceBinding): TrustedHostCapabilityEvidenceBinding {
  const id = bounded(binding.id, "host evidence binding id", 96);
  const capabilityId = bounded(binding.capabilityId, "host evidence capabilityId", 256);
  const expectedFunction = bounded(binding.expectedFunction, "host evidence expectedFunction", 256);
  const claim = bounded(binding.claim, "host evidence claim", 4_096);
  if (binding.readOnly !== true) {
    throw new Error(`Host evidence binding ${id} must explicitly declare readOnly=true`);
  }
  if (binding.profileKinds.length === 0) throw new Error(`Host evidence binding ${id} requires at least one profile kind`);
  return {
    ...binding,
    id,
    capabilityId,
    expectedFunction,
    claim,
    profileKinds: [...new Set(binding.profileKinds)],
    ...(binding.artifactTypes ? { artifactTypes: [...new Set(binding.artifactTypes)] } : {}),
    allowedPermissions: [...new Set(binding.allowedPermissions ?? [])]
  };
}

function assertCapabilityEligible(
  capability: CapabilityDescriptor,
  binding: TrustedHostCapabilityEvidenceBinding
): void {
  if (!capability.available) throw new Error(`Host evidence capability is unavailable: ${capability.id}`);
  if (!capability.hostNative || capability.scope !== "host") {
    throw new Error(`Evidence capability must be host-native and host-scoped: ${capability.id}`);
  }
  if (capability.routing?.executionMode !== "host-capability") {
    throw new Error(`Evidence capability must declare routing.executionMode=host-capability: ${capability.id}`);
  }
  if (!capability.functions?.includes(binding.expectedFunction)) {
    throw new Error(`Evidence capability ${capability.id} does not advertise required semantic function ${binding.expectedFunction}`);
  }
  const allowedPermissions = new Set(binding.allowedPermissions ?? []);
  const unexpectedPermissions = capability.permissions.filter(permission => !allowedPermissions.has(permission));
  if (unexpectedPermissions.length > 0) {
    throw new Error(
      `Evidence capability ${capability.id} declares permissions not approved as read-only for binding ${binding.id}: ${unexpectedPermissions.join(", ")}`
    );
  }
  if (capability.cost?.metered && !binding.allowMetered) {
    throw new Error(`Evidence capability ${capability.id} is metered but binding ${binding.id} does not allow metered use`);
  }
  const actualCost = capability.cost?.monetaryClass ?? "unknown";
  const maximum = binding.maxMonetaryClass ?? "low";
  if (COST_RANK[actualCost] > COST_RANK[maximum]) {
    throw new Error(`Evidence capability ${capability.id} monetary class ${actualCost} exceeds binding limit ${maximum}`);
  }
}

function normalizeOutput(value: unknown): HostEvidenceOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Host evidence capability output must be an object");
  }
  const object = value as Record<string, unknown>;
  const result = object.result;
  if (typeof result !== "string" || !RESULT_VALUES.has(result as Evidence["result"])) {
    throw new Error(`Host evidence capability returned unsupported result: ${String(result)}`);
  }
  if (object.summary !== undefined && typeof object.summary !== "string") {
    throw new Error("Host evidence capability summary must be a string when supplied");
  }
  const summary = typeof object.summary === "string" ? object.summary.trim() : undefined;
  if (summary && summary.length > 4_096) throw new Error(`Host evidence capability summary is too long: ${summary.length}`);
  return {
    result: result as Evidence["result"],
    ...(summary ? { summary } : {}),
    ...(object.inspectionPayload === undefined ? {} : { inspectionPayload: structuredClone(object.inspectionPayload) })
  };
}

function serializedBytes(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`Host evidence capability output is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (serialized === undefined) throw new Error("Host evidence capability output is not JSON-serializable");
  return Buffer.byteLength(serialized, "utf8");
}

function bounded(value: string, label: string, maxChars: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be non-empty`);
  if (trimmed.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  return trimmed;
}

function safeSourceSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown";
}
