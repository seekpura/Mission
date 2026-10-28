import type { ArtifactType } from "../domain/artifact.ts";

export const WORKER_RECOVERY_FILE = ".mission-worker-output.json";

export interface WorkerOutputFile {
  path: string;
  logicalName: string;
  type: ArtifactType;
  requirementRefs?: string[];
}

export interface WorkerOutputEnvelope {
  status: "completed" | "partial" | "failed";
  summary: string;
  outputs: WorkerOutputFile[];
  proposedFacts: Array<{ key: string; value: unknown; confidence?: number }>;
  proposedWork: Array<{ objective: string; reason?: string; requirementRefs?: string[]; gapRefs?: string[] }>;
  warnings: string[];
}

export function workerProtocolInstruction(workspaceRoot: string): string {
  return `
WORKER OUTPUT CONTRACT
You are executing one Mission WorkItem. Work only on the assigned objective and available context.
Write user-facing files inside this workspace: ${workspaceRoot}
When finished, first write the exact JSON object below to ${workspaceRoot}/${WORKER_RECOVERY_FILE}. Then your FINAL assistant message MUST be the same JSON object (no markdown fence):
{
  "status":"completed|partial|failed",
  "summary":"what was actually accomplished",
  "outputs":[{"path":"relative/path.ext","logicalName":"stable-artifact-name","type":"file|document|presentation|image|video|audio|code|website|dataset|research|other","requirementRefs":["R1"]}],
  "proposedFacts":[],
  "proposedWork":[],
  "warnings":[]
}
The recovery file is part of the execution protocol and must be written before the final response so Mission Control can recover from a runtime crash. Do not claim files that do not exist. proposedWork is advisory only; Mission Control decides whether to promote it.
`;
}

export function parseWorkerOutput(value: unknown): WorkerOutputEnvelope | null {
  const text = extractText(value);
  if (!text) return null;
  const parsed = parseObject(text);
  if (!parsed || !["completed", "partial", "failed"].includes(String(parsed.status))) return null;
  const outputs = Array.isArray(parsed.outputs) ? parsed.outputs.flatMap((raw: any) => {
    if (!raw || typeof raw.path !== "string" || typeof raw.logicalName !== "string") return [];
    return [{
      path: raw.path,
      logicalName: raw.logicalName,
      type: artifactType(raw.type),
      requirementRefs: Array.isArray(raw.requirementRefs) ? raw.requirementRefs.filter((x: unknown): x is string => typeof x === "string") : []
    }];
  }) : [];
  return {
    status: parsed.status,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    outputs,
    proposedFacts: Array.isArray(parsed.proposedFacts) ? parsed.proposedFacts.filter((x: unknown) => !!x && typeof x === "object") : [],
    proposedWork: Array.isArray(parsed.proposedWork) ? parsed.proposedWork.filter((x: unknown) => !!x && typeof x === "object") : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.filter((x: unknown): x is string => typeof x === "string") : []
  };
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") {
    try {
      const outer = JSON.parse(value);
      if (outer && typeof outer === "object" && typeof outer.text === "string") return outer.text;
    } catch {}
    return value;
  }
  if (value && typeof value === "object" && typeof (value as any).text === "string") return (value as any).text;
  return null;
}

function parseObject(text: string): any | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); } catch {}
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(stripped.slice(start, end + 1)); } catch { return null; }
}

function artifactType(value: unknown): ArtifactType {
  const allowed: ArtifactType[] = ["file", "document", "presentation", "image", "video", "audio", "code", "website", "dataset", "research", "other"];
  return allowed.includes(value as ArtifactType) ? value as ArtifactType : "file";
}
