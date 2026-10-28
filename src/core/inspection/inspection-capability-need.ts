import type { Artifact } from "../domain/artifact.ts";
import type { CapabilityNeed } from "../domain/capability.ts";
import type { InspectionRequest } from "../domain/inspection.ts";

export function inspectionCapabilityNeed(artifact: Artifact, request: InspectionRequest): CapabilityNeed {
  const id = `verification-inspection-${safe(artifact.type)}-${safe(request.kind)}`;
  const functions = requiredFunctions(artifact, request);
  return {
    id,
    missionId: artifact.missionId,
    objective: objectiveFor(artifact, request),
    requiredFunctions: functions,
    desiredInputs: [artifact.type, artifact.uri],
    desiredOutputs: outputKinds(request),
    purpose: "verification",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk: "medium",
    requirementRefs: [...new Set(request.requirementRefs)],
    gapRefs: [],
    status: "checking-installed"
  };
}

function objectiveFor(artifact: Artifact, request: InspectionRequest): string {
  if (request.kind === "page-render") return `Render ${artifact.type} pages or slides to inspectable images for verification`;
  if (request.kind === "viewport-screenshot") return "Render the website in a browser and capture inspectable viewport screenshots for verification";
  if (request.kind === "keyframe") return "Extract inspectable video keyframes for perceptual verification";
  return `Extract inspectable metadata from ${artifact.type} for verification`;
}

function requiredFunctions(artifact: Artifact, request: InspectionRequest): string[] {
  if (request.kind === "page-render") return ["render pages to images", `render ${artifact.type}`, "inspection output"];
  if (request.kind === "viewport-screenshot") return ["browser render", "viewport screenshot", "website inspection"];
  if (request.kind === "keyframe") return ["video keyframe extraction", "video inspection", "frame export"];
  return [`${artifact.type} metadata extraction`, "inspection output"];
}

function outputKinds(request: InspectionRequest): string[] {
  if (["page-render", "viewport-screenshot", "keyframe"].includes(request.kind)) return ["image files", "inspection bundle"];
  return ["metadata", "inspection bundle"];
}

function safe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}
