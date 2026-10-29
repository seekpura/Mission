import type { ArtifactType } from "../core/domain/artifact.ts";
import type { CapabilityCostClass, CapabilityDescriptor } from "../core/domain/capability.ts";
import type { Evidence, VerificationEvidenceKind } from "../core/domain/verification.ts";
import type {
  VerificationEvidenceCollector,
  VerificationEvidenceCollectorInput,
  VerificationEvidenceDraft
} from "../core/verification/evidence-collector.ts";
import type { VerificationProfileKind } from "../core/verification/verification-profile.ts";
import type { HostAdapter } from "../hosts/host-adapter.ts";
import { validateStructuredProviderObservation } from "./provider-evidence-observation.ts";

export const STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL = "mission-evidence/v1" as const;

export const STRUCTURED_PROVIDER_EVIDENCE_KINDS = [
  "presentation-render",
  "browser-runtime",
  "accessibility-check",
  "media-probe",
  "media-playback",
  "executable-test",
  "build-check",
  "integration-test",
  "source-recency"
] as const satisfies readonly VerificationEvidenceKind[];

export type StructuredProviderEvidenceKind = typeof STRUCTURED_PROVIDER_EVIDENCE_KINDS[number];

export interface TrustedProviderEvidenceRoute {
  /** Stable Runtime-owned deployment route id. */
  id: string;
  /** Exact live HostAdapter capability id. */
  capabilityId: string;
  /** Exact capability.native.provider identity expected from the live host. */
  provider: string;
  /** Structured output protocol. Currently only mission-evidence/v1 is trusted. */
  protocol: typeof STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL;
  /** Optional exact provider-native capability id pin. */
  nativeId?: string;
  evidenceKind: StructuredProviderEvidenceKind;
  /** Must be literally true; this route never grants mutation authority. */
  readOnly: true;
  /** Exact provider permissions accepted as read-only for this route. */
  allowedPermissions?: string[];
  allowMetered?: boolean;
  maxMonetaryClass?: Exclude<CapabilityCostClass, "unknown">;
  maxOutputBytes?: number;
}

interface ProviderEvidenceSpec {
  expectedFunction: string;
  evidenceType: Evidence["type"];
  profileKinds: readonly VerificationProfileKind[];
  artifactTypes: readonly ArtifactType[];
  claim: string;
}

interface StructuredProviderOutput {
  result: Evidence["result"];
  observedAt: string;
  summary?: string;
  observation?: unknown;
}

const RESULT_VALUES = new Set<Evidence["result"]>(["supports", "contradicts", "inconclusive"]);
const ROUTE_KINDS = new Set<StructuredProviderEvidenceKind>(STRUCTURED_PROVIDER_EVIDENCE_KINDS);
const MAX_MONETARY = new Set<Exclude<CapabilityCostClass, "unknown">>(["negligible", "low", "medium", "high"]);
const COST_RANK: Record<CapabilityCostClass, number> = {
  negligible: 0,
  low: 1,
  medium: 2,
  high: 3,
  unknown: 4
};

const PROVIDER_EVIDENCE_SPECS: Record<StructuredProviderEvidenceKind, ProviderEvidenceSpec> = {
  "presentation-render": {
    expectedFunction: "verification.presentation.render",
    evidenceType: "render-inspection",
    profileKinds: ["presentation"],
    artifactTypes: ["presentation"],
    claim: "A trusted provider rendered the exact presentation artifact and returned a structured render observation."
  },
  "browser-runtime": {
    expectedFunction: "verification.browser.inspect",
    evidenceType: "runtime-check",
    profileKinds: ["website"],
    artifactTypes: ["website"],
    claim: "A trusted provider inspected the exact website artifact in a browser runtime and returned a structured runtime observation."
  },
  "accessibility-check": {
    expectedFunction: "verification.accessibility.audit",
    evidenceType: "automated-review",
    profileKinds: ["website"],
    artifactTypes: ["website"],
    claim: "A trusted provider ran an accessibility audit against the exact website artifact and returned a structured accessibility observation."
  },
  "media-probe": {
    expectedFunction: "verification.media.probe",
    evidenceType: "runtime-check",
    profileKinds: ["video"],
    artifactTypes: ["video", "audio"],
    claim: "A trusted provider probed the exact media artifact and returned a structured media observation."
  },
  "media-playback": {
    expectedFunction: "verification.media.playback",
    evidenceType: "runtime-check",
    profileKinds: ["video"],
    artifactTypes: ["video", "audio"],
    claim: "A trusted provider played the exact media artifact and returned a structured playback observation."
  },
  "executable-test": {
    expectedFunction: "verification.code.test",
    evidenceType: "test-result",
    profileKinds: ["code"],
    artifactTypes: ["code"],
    claim: "A trusted provider executed tests against the exact code artifact and returned a structured test observation."
  },
  "build-check": {
    expectedFunction: "verification.code.build",
    evidenceType: "test-result",
    profileKinds: ["code"],
    artifactTypes: ["code"],
    claim: "A trusted provider executed a build check against the exact code artifact and returned a structured build observation."
  },
  "integration-test": {
    expectedFunction: "verification.code.integration-test",
    evidenceType: "test-result",
    profileKinds: ["code"],
    artifactTypes: ["code"],
    claim: "A trusted provider executed integration tests against the exact code artifact and returned a structured integration-test observation."
  },
  "source-recency": {
    expectedFunction: "verification.research.recency",
    evidenceType: "source",
    profileKinds: ["research"],
    artifactTypes: ["research"],
    claim: "A trusted provider checked source recency for the exact research artifact and returned a structured recency observation."
  }
};

/**
 * Production bridge for provider-native read-only verification capabilities.
 *
 * Unlike the low-level TrustedHostCapabilityEvidenceCollector, deployment
 * configuration cannot choose the semantic function, evidence type, profile,
 * artifact class or durable claim. Those are Runtime-owned by evidence kind.
 * The live capability must also pin provider + protocol identity, and the
 * provider response must bind itself back to the exact artifact id/hash.
 */
export class StructuredProviderEvidenceCollector implements VerificationEvidenceCollector {
  readonly id: string;
  readonly kinds: readonly VerificationEvidenceKind[];
  private readonly host: HostAdapter;
  private readonly route: TrustedProviderEvidenceRoute;
  private readonly spec: ProviderEvidenceSpec;
  private readonly maxOutputBytes: number;

  constructor(host: HostAdapter, route: TrustedProviderEvidenceRoute) {
    this.host = host;
    this.route = validateRoute(route);
    this.spec = PROVIDER_EVIDENCE_SPECS[this.route.evidenceKind];
    this.maxOutputBytes = this.route.maxOutputBytes ?? 256 * 1024;
    this.id = `provider-evidence:${this.route.id}`;
    this.kinds = [this.route.evidenceKind];
  }

  supports(input: VerificationEvidenceCollectorInput): boolean {
    return this.spec.profileKinds.includes(input.profile.kind) && this.spec.artifactTypes.includes(input.artifact.type);
  }

  async collect(input: VerificationEvidenceCollectorInput): Promise<VerificationEvidenceDraft[]> {
    const snapshot = await this.host.snapshotEnvironment();
    const capability = snapshot.capabilities.find(item => item.id === this.route.capabilityId);
    if (!capability) throw new Error(`Configured provider evidence capability is absent: ${this.route.capabilityId}`);
    assertCapabilityEligible(capability, this.route, this.spec);

    const response = await this.host.invokeHostCapability({
      capabilityId: capability.id,
      input: {
        operation: "mission.verification.collect_evidence",
        contract: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
        routeId: this.route.id,
        evidenceKind: this.route.evidenceKind,
        missionId: input.artifact.missionId,
        subject: {
          artifactId: input.artifact.id,
          contentHash: input.artifact.contentHash
        },
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
      throw new Error(`Provider evidence capability ${capability.id} failed: ${response.error ?? "unknown provider error"}`);
    }

    const bytes = serializedBytes(response.output);
    if (bytes > this.maxOutputBytes) {
      throw new Error(`Provider evidence capability ${capability.id} output exceeds ${this.maxOutputBytes} bytes`);
    }
    const output = normalizeStructuredOutput(response.output, this.route.evidenceKind, input.artifact.id, input.artifact.contentHash);
    const sourceRevision = capability.revision ?? capability.provenance?.revision ?? snapshot.revision.toString();
    const sourceRef = [
      "provider-capability",
      safeSourceSegment(this.route.provider),
      `${safeSourceSegment(capability.id)}@${safeSourceSegment(sourceRevision)}`
    ].join(":");
    const transient = output.observation === undefined && !output.summary
      ? undefined
      : {
          ...(output.summary ? { summary: output.summary } : {}),
          ...(output.observation === undefined ? {} : { evidence: output.observation })
        };

    return [{
      type: this.spec.evidenceType,
      kind: this.route.evidenceKind,
      claim: this.spec.claim,
      result: output.result,
      sourceRef,
      details: {
        routeId: this.route.id,
        capabilityId: capability.id,
        capabilityRevision: sourceRevision,
        semanticFunction: this.spec.expectedFunction,
        provider: this.route.provider,
        protocol: this.route.protocol,
        observedAt: output.observedAt,
        hostType: snapshot.host.type,
        ...(snapshot.host.version ? { hostVersion: snapshot.host.version } : {}),
        ...(capability.native?.nativeId ? { nativeId: capability.native.nativeId } : {})
      },
      ...(transient === undefined ? {} : { inspectionPayload: transient })
    }];
  }
}

export function createStructuredProviderEvidenceCollectors(
  host: HostAdapter,
  routes: TrustedProviderEvidenceRoute[]
): VerificationEvidenceCollector[] {
  const ids = new Set<string>();
  return routes.map(route => {
    const normalized = validateRoute(route);
    if (ids.has(normalized.id)) throw new Error(`Duplicate provider evidence route id: ${normalized.id}`);
    ids.add(normalized.id);
    return new StructuredProviderEvidenceCollector(host, normalized);
  });
}

export function parseTrustedProviderEvidenceRoutesJson(value: string | undefined): TrustedProviderEvidenceRoute[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `MISSION_EVIDENCE_PROVIDER_ROUTES_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed)) throw new Error("MISSION_EVIDENCE_PROVIDER_ROUTES_JSON must be a JSON array");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Provider evidence route[${index}] must be an object`);
    }
    const object = item as Record<string, unknown>;
    const route: TrustedProviderEvidenceRoute = {
      id: stringField(object, "id", index),
      capabilityId: stringField(object, "capabilityId", index),
      provider: stringField(object, "provider", index),
      protocol: stringField(object, "protocol", index) as typeof STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
      ...(object.nativeId === undefined ? {} : { nativeId: stringField(object, "nativeId", index) }),
      evidenceKind: stringField(object, "evidenceKind", index) as StructuredProviderEvidenceKind,
      readOnly: object.readOnly as true,
      ...(object.allowedPermissions === undefined
        ? {}
        : { allowedPermissions: stringArrayField(object, "allowedPermissions", index) }),
      ...(object.allowMetered === undefined ? {} : { allowMetered: booleanField(object, "allowMetered", index) }),
      ...(object.maxMonetaryClass === undefined
        ? {}
        : { maxMonetaryClass: stringField(object, "maxMonetaryClass", index) as Exclude<CapabilityCostClass, "unknown"> }),
      ...(object.maxOutputBytes === undefined
        ? {}
        : { maxOutputBytes: positiveIntegerField(object, "maxOutputBytes", index) })
    };
    return validateRoute(route);
  });
}

export function providerEvidenceSpec(kind: StructuredProviderEvidenceKind): Readonly<ProviderEvidenceSpec> {
  return PROVIDER_EVIDENCE_SPECS[kind];
}

function validateRoute(route: TrustedProviderEvidenceRoute): TrustedProviderEvidenceRoute {
  const id = bounded(route.id, "provider evidence route id", 96);
  const capabilityId = bounded(route.capabilityId, "provider evidence capabilityId", 256);
  const provider = bounded(route.provider, "provider evidence provider", 128);
  if (route.protocol !== STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL) {
    throw new Error(
      `Provider evidence route ${id} protocol must be ${STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL}; received ${String(route.protocol)}`
    );
  }
  if (!ROUTE_KINDS.has(route.evidenceKind)) {
    throw new Error(`Provider evidence route ${id} has unsupported evidenceKind ${String(route.evidenceKind)}`);
  }
  if (route.readOnly !== true) throw new Error(`Provider evidence route ${id} must explicitly declare readOnly=true`);
  const nativeId = route.nativeId === undefined ? undefined : bounded(route.nativeId, "provider evidence nativeId", 256);
  const allowedPermissions = [...new Set((route.allowedPermissions ?? []).map(permission => bounded(permission, "allowed permission", 256)))];
  if (route.maxMonetaryClass !== undefined && !MAX_MONETARY.has(route.maxMonetaryClass)) {
    throw new Error(`Provider evidence route ${id} has unsupported maxMonetaryClass ${String(route.maxMonetaryClass)}`);
  }
  if (route.maxOutputBytes !== undefined &&
      (!Number.isInteger(route.maxOutputBytes) || route.maxOutputBytes < 1_024 || route.maxOutputBytes > 2 * 1024 * 1024)) {
    throw new Error(`Provider evidence route ${id} maxOutputBytes must be an integer between 1024 and 2097152`);
  }
  return {
    ...route,
    id,
    capabilityId,
    provider,
    ...(nativeId ? { nativeId } : {}),
    allowedPermissions
  };
}

function assertCapabilityEligible(
  capability: CapabilityDescriptor,
  route: TrustedProviderEvidenceRoute,
  spec: ProviderEvidenceSpec
): void {
  if (!capability.available) throw new Error(`Provider evidence capability is unavailable: ${capability.id}`);
  if (!capability.hostNative || capability.scope !== "host") {
    throw new Error(`Provider evidence capability must be host-native and host-scoped: ${capability.id}`);
  }
  if (capability.routing?.executionMode !== "host-capability") {
    throw new Error(`Provider evidence capability must declare routing.executionMode=host-capability: ${capability.id}`);
  }
  if (!capability.functions?.includes(spec.expectedFunction)) {
    throw new Error(`Provider evidence capability ${capability.id} does not advertise required semantic function ${spec.expectedFunction}`);
  }
  if (!capability.produces?.includes("verification-evidence")) {
    throw new Error(`Provider evidence capability ${capability.id} must advertise verification-evidence output`);
  }
  if (capability.native?.provider !== route.provider) {
    throw new Error(
      `Provider evidence capability ${capability.id} provider ${String(capability.native?.provider)} does not match trusted route ${route.provider}`
    );
  }
  if (capability.native?.protocol !== route.protocol) {
    throw new Error(
      `Provider evidence capability ${capability.id} protocol ${String(capability.native?.protocol)} does not match trusted route ${route.protocol}`
    );
  }
  if (route.nativeId !== undefined && capability.native?.nativeId !== route.nativeId) {
    throw new Error(
      `Provider evidence capability ${capability.id} nativeId ${String(capability.native?.nativeId)} does not match trusted route ${route.nativeId}`
    );
  }
  const allowedPermissions = new Set(route.allowedPermissions ?? []);
  const unexpectedPermissions = capability.permissions.filter(permission => !allowedPermissions.has(permission));
  if (unexpectedPermissions.length > 0) {
    throw new Error(
      `Provider evidence capability ${capability.id} declares permissions not approved as read-only for route ${route.id}: ${unexpectedPermissions.join(", ")}`
    );
  }
  if (capability.cost?.metered && !route.allowMetered) {
    throw new Error(`Provider evidence capability ${capability.id} is metered but route ${route.id} does not allow metered use`);
  }
  const actualCost = capability.cost?.monetaryClass ?? "unknown";
  const maximum = route.maxMonetaryClass ?? "low";
  if (COST_RANK[actualCost] > COST_RANK[maximum]) {
    throw new Error(`Provider evidence capability ${capability.id} monetary class ${actualCost} exceeds route limit ${maximum}`);
  }
}

function normalizeStructuredOutput(
  value: unknown,
  expectedKind: StructuredProviderEvidenceKind,
  artifactId: string,
  contentHash: string
): StructuredProviderOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider evidence output must be an object");
  }
  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL) {
    throw new Error(`Provider evidence output schemaVersion must be ${STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL}`);
  }
  if (object.evidenceKind !== expectedKind) {
    throw new Error(`Provider evidence output kind ${String(object.evidenceKind)} does not match requested ${expectedKind}`);
  }
  if (!object.subject || typeof object.subject !== "object" || Array.isArray(object.subject)) {
    throw new Error("Provider evidence output subject must be an object");
  }
  const subject = object.subject as Record<string, unknown>;
  if (subject.artifactId !== artifactId || subject.contentHash !== contentHash) {
    throw new Error("Provider evidence output subject does not match the exact artifact id/contentHash requested by Runtime");
  }
  const result = object.result;
  if (typeof result !== "string" || !RESULT_VALUES.has(result as Evidence["result"])) {
    throw new Error(`Provider evidence output returned unsupported result: ${String(result)}`);
  }
  const observedAt = typeof object.observedAt === "string" ? object.observedAt.trim() : "";
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error("Provider evidence output observedAt must be a valid timestamp");
  }
  if (object.summary !== undefined && typeof object.summary !== "string") {
    throw new Error("Provider evidence output summary must be a string when supplied");
  }
  const summary = typeof object.summary === "string" ? object.summary.trim() : undefined;
  if (summary && summary.length > 4_096) throw new Error(`Provider evidence output summary is too long: ${summary.length}`);
  const observation = validateStructuredProviderObservation(
    expectedKind,
    result as Evidence["result"],
    object.observation
  );
  return {
    result: result as Evidence["result"],
    observedAt,
    ...(summary ? { summary } : {}),
    ...(observation === undefined ? {} : { observation })
  };
}

function serializedBytes(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`Provider evidence output is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (serialized === undefined) throw new Error("Provider evidence output is not JSON-serializable");
  return Buffer.byteLength(serialized, "utf8");
}

function bounded(value: string, label: string, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be non-empty`);
  if (trimmed.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  return trimmed;
}

function safeSourceSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown";
}

function stringField(object: Record<string, unknown>, field: string, index: number): string {
  const value = object[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Provider evidence route[${index}].${field} must be a non-empty string`);
  return value;
}

function stringArrayField(object: Record<string, unknown>, field: string, index: number): string[] {
  const value = object[field];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`Provider evidence route[${index}].${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function booleanField(object: Record<string, unknown>, field: string, index: number): boolean {
  const value = object[field];
  if (typeof value !== "boolean") throw new Error(`Provider evidence route[${index}].${field} must be a boolean`);
  return value;
}

function positiveIntegerField(object: Record<string, unknown>, field: string, index: number): number {
  const value = object[field];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`Provider evidence route[${index}].${field} must be a positive integer`);
  }
  return value as number;
}
