import type { Artifact } from "../domain/artifact.ts";
import type { CapabilityDescriptor, CapabilityNeed } from "../domain/capability.ts";
import type { InspectionBundle, InspectionContext, InspectionRequest } from "../domain/inspection.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";
import type { HostAdapter } from "../../hosts/deepseek/host-adapter.ts";
import { CapabilityResolver } from "../capabilities/resolver.ts";
import { inspectionCapabilityNeed } from "./inspection-capability-need.ts";
import type { InspectionProvider } from "./inspection-provider.ts";

export class InspectionCapabilityUnavailableError extends Error {
  readonly need: CapabilityNeed;
  constructor(need: CapabilityNeed) {
    super(`Inspection capability unavailable: ${need.objective}`);
    this.name = "InspectionCapabilityUnavailableError";
    this.need = need;
  }
}

export class CapabilityBackedInspectionProvider implements InspectionProvider {
  id = "capability-backed-inspection";
  version = "1";
  private readonly host: HostAdapter;
  private readonly projections: MissionProjectionReader;
  private readonly resolver: CapabilityResolver;

  constructor(input: { host: HostAdapter; projections: MissionProjectionReader; resolver?: CapabilityResolver }) {
    this.host = input.host;
    this.projections = input.projections;
    this.resolver = input.resolver ?? new CapabilityResolver();
  }

  supports(_artifact: Artifact, request: InspectionRequest): boolean {
    return ["page-render", "viewport-screenshot", "keyframe", "metadata"].includes(request.kind);
  }

  async inspect(artifact: Artifact, request: InspectionRequest, context: InspectionContext): Promise<InspectionBundle> {
    const need = inspectionCapabilityNeed(artifact, request);
    const [environment, missionCapabilities] = await Promise.all([
      this.host.snapshotEnvironment(),
      this.projections.listCapabilities(artifact.missionId)
    ]);
    const effective = mergeCapabilities(environment.capabilities, missionCapabilities);
    const explicit = effective.find(capability => declaresInspectionKind(capability, request.kind));
    const resolution = explicit ? { status: "resolved" as const, capability: explicit } : this.resolver.resolve(need, effective);
    if (resolution.status !== "resolved" || !resolution.capability) throw new InspectionCapabilityUnavailableError(need);
    const capability = resolution.capability;

    if (capability.hostNative && ["tool", "mcp", "workflow"].includes(capability.kind) && capability.metadata?.inspectionProtocol === "inspection-bundle-v1") {
      const result = await this.host.invokeHostCapability({
        missionId: artifact.missionId,
        workItemId: `inspection:${artifact.id}:${request.kind}`,
        capabilityId: capability.id,
        invocationRef: capability.invocationRef,
        workspaceRoot: context.outputDir,
        idempotencyKey: `inspection:${artifact.missionId}:${artifact.contentHash}:${request.kind}:${capability.id}`,
        input: inspectionInput(artifact, request, context, capability)
      });
      if (!result.ok) throw new Error(result.error ?? `Inspection capability failed: ${capability.id}`);
      return parseBundle(result.output, artifact, capability);
    }

    const handle = await this.host.createAgent({
      missionId: artifact.missionId,
      workItemId: `inspection:${artifact.id}:${request.kind}`,
      workspaceRoot: context.outputDir,
      allowedCapabilityRefs: capability.hostNative ? [capability.id] : [],
      context: {
        kind: "inspection-production",
        instruction: "Produce the requested observable inspection artifacts in outputDir. Do not alter the source artifact. Return only the inspection bundle contract after files are written.",
        sourceArtifact: artifact,
        request,
        outputDir: context.outputDir,
        capability,
        invocationHint: capability.hostNative ? undefined : capability.invocationRef,
        responseContract: {
          providerId: "string",
          sourceArtifactRef: `${artifact.id}@${artifact.version}`,
          products: [{ kind: request.kind, path: "path inside outputDir", type: "image|document|file", logicalSuffix: "optional", mimeType: "optional" }]
        }
      }
    });
    let payload: unknown;
    let failure: unknown;
    for await (const event of this.host.observeAgent(handle)) {
      if (event.type === "completed") payload = event.payload;
      if (event.type === "failed") failure = event.payload;
    }
    if (failure !== undefined) throw new Error(`Inspection agent failed: ${errorMessage(failure)}`);
    return parseBundle(payload, artifact, capability);
  }
}

function inspectionInput(artifact: Artifact, request: InspectionRequest, context: InspectionContext, capability: CapabilityDescriptor) {
  return {
    protocol: "inspection-bundle-v1",
    sourceArtifact: artifact,
    request,
    outputDir: context.outputDir,
    capability: { id: capability.id, revision: capability.revision }
  };
}

function parseBundle(value: unknown, artifact: Artifact, capability: CapabilityDescriptor): InspectionBundle {
  let candidate: any = value;
  if (candidate && typeof candidate === "object" && typeof candidate.text === "string") candidate = parseJson(candidate.text);
  else if (typeof candidate === "string") candidate = parseJson(candidate);
  if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.products)) throw new Error(`Inspection capability ${capability.id} did not return an inspection bundle`);
  const products = candidate.products
    .filter((item: any) => item && typeof item === "object" && typeof item.kind === "string" && typeof item.path === "string" && typeof item.type === "string")
    .map((item: any) => ({ kind: item.kind, path: item.path, type: item.type, logicalSuffix: typeof item.logicalSuffix === "string" ? item.logicalSuffix : undefined, mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined }));
  if (products.length === 0) throw new Error(`Inspection capability ${capability.id} returned no valid products`);
  return {
    providerId: `capability:${capability.id}`,
    providerVersion: capability.revision ?? capability.contentHash ?? "1",
    sourceArtifactRef: typeof candidate.sourceArtifactRef === "string" ? candidate.sourceArtifactRef : `${artifact.id}@${artifact.version}`,
    products
  } as InspectionBundle;
}

function parseJson(value: string): unknown {
  const stripped = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); } catch {}
  const start = stripped.indexOf("{"); const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
  throw new Error("Inspection agent did not return JSON");
}

function declaresInspectionKind(capability: CapabilityDescriptor, kind: InspectionRequest["kind"]): boolean {
  const declared = capability.metadata?.inspectionKinds;
  return Array.isArray(declared) && declared.includes(kind);
}

function mergeCapabilities(...groups: CapabilityDescriptor[][]): CapabilityDescriptor[] {
  const map = new Map<string, CapabilityDescriptor>();
  for (const group of groups) for (const capability of group) if (capability.available) map.set(capability.id, capability);
  return [...map.values()];
}

function errorMessage(value: unknown): string {
  if (value && typeof value === "object" && typeof (value as any).error === "string") return (value as any).error;
  return typeof value === "string" ? value : JSON.stringify(value);
}
