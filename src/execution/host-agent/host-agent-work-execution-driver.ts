import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Artifact, ArtifactType } from "../../core/domain/artifact.ts";
import type { ExecutionResult, ProducedFile } from "../../core/domain/execution.ts";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome
} from "../../core/execution/work-execution-driver.ts";
import type { HostAdapter, HostAgentEvent } from "../../hosts/deepseek/host-adapter.ts";
import { FileArtifactStore } from "../artifacts/artifact-store.ts";
import { WorkspaceManager } from "../workspace/workspace-manager.ts";

const OUTPUT_MANIFEST = ".mission/output-manifest.json";
const HOST_EVENT_LOG = ".mission/host-events.ndjson";
const ARTIFACT_TYPES = new Set<ArtifactType>([
  "file",
  "document",
  "presentation",
  "image",
  "video",
  "audio",
  "code",
  "website",
  "dataset",
  "research",
  "other"
]);

export interface HostAgentWorkExecutionDriverOptions {
  hardTimeoutMs?: number;
}

interface OutputManifestArtifact {
  logicalName: string;
  type: ArtifactType;
  path: string;
  mimeType?: string;
}

interface OutputManifest {
  version: 1;
  artifacts: OutputManifestArtifact[];
}

interface ObservationSummary {
  completed: boolean;
  failed: boolean;
  timedOut: boolean;
  failurePayload?: unknown;
  events: HostAgentEvent[];
}

export class HostAgentWorkExecutionDriver implements WorkExecutionDriver {
  readonly id = "host-agent";
  private readonly host: HostAdapter;
  private readonly workspaces: WorkspaceManager;
  private readonly artifacts: FileArtifactStore;
  private readonly hardTimeoutMs: number;

  constructor(
    host: HostAdapter,
    workspaces: WorkspaceManager,
    artifacts: FileArtifactStore,
    options: HostAgentWorkExecutionDriverOptions = {}
  ) {
    this.host = host;
    this.workspaces = workspaces;
    this.artifacts = artifacts;
    this.hardTimeoutMs = Math.max(1_000, options.hardTimeoutMs ?? 30 * 60_000);
  }

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    const startedAt = new Date().toISOString();
    const workspace = this.workspaces.allocate(input.workItem.missionId, input.attemptId);
    const manifestPath = join(workspace.root, OUTPUT_MANIFEST);
    const logPath = join(workspace.root, HOST_EVENT_LOG);

    const handle = await this.host.createAgent({
      missionId: input.workItem.missionId,
      workItemId: input.workItem.id,
      workspaceRoot: workspace.root,
      allowedCapabilityRefs: [...input.contextPacket.allowedCapabilityRefs],
      context: {
        contextPacket: input.contextPacket,
        outputContract: {
          version: 1,
          manifestPath: OUTPUT_MANIFEST,
          rules: [
            "Write produced deliverable files inside the supplied workspace only.",
            "Do not treat chat text or tool messages as deliverables.",
            "When work is complete, write the output manifest as UTF-8 JSON.",
            "Manifest artifact paths must be relative to the workspace and must identify existing files.",
            "Only include artifacts actually produced by this work item."
          ],
          manifestShape: {
            version: 1,
            artifacts: [
              {
                logicalName: "string",
                type: "file|document|presentation|image|video|audio|code|website|dataset|research|other",
                path: "relative/path/from/workspace",
                mimeType: "optional string"
              }
            ]
          },
          expectedOutputs: input.workItem.expectedOutputs
        }
      }
    });

    const observation = await observeToTerminal(this.host, handle, this.hardTimeoutMs);
    writeHostEventLog(logPath, observation.events);

    if (observation.timedOut) {
      return outcome(input.executionId, "timed_out", startedAt, logPath, [], []);
    }
    if (observation.failed || !observation.completed) {
      return outcome(input.executionId, "failed", startedAt, logPath, [], []);
    }

    const manifest = existsSync(manifestPath)
      ? parseManifest(readFileSync(manifestPath, "utf8"))
      : { version: 1 as const, artifacts: [] };

    const committed: Artifact[] = [];
    const producedFiles: ProducedFile[] = [];
    const seenLogicalNames = new Set<string>();

    for (const declared of manifest.artifacts) {
      if (seenLogicalNames.has(declared.logicalName)) {
        throw new Error(`Duplicate artifact logicalName in host output manifest: ${declared.logicalName}`);
      }
      seenLogicalNames.add(declared.logicalName);

      const sourcePath = secureWorkspaceFile(workspace.root, declared.path);
      producedFiles.push({
        path: sourcePath,
        logicalName: declared.logicalName,
        type: declared.type
      });
      committed.push(this.artifacts.commit({
        missionId: input.workItem.missionId,
        logicalName: declared.logicalName,
        type: declared.type,
        sourcePath,
        producedByAttemptId: input.attemptId,
        sourceArtifactRefs: [...input.workItem.inputArtifactRefs],
        mimeType: declared.mimeType
      }));
    }

    return outcome(
      input.executionId,
      "succeeded",
      startedAt,
      logPath,
      producedFiles,
      committed
    );
  }
}

async function observeToTerminal(
  host: HostAdapter,
  handle: Awaited<ReturnType<HostAdapter["createAgent"]>>,
  hardTimeoutMs: number
): Promise<ObservationSummary> {
  const events: HostAgentEvent[] = [];
  const iterator = host.observeAgent(handle)[Symbol.asyncIterator]();
  const deadline = Date.now() + hardTimeoutMs;
  let completed = false;
  let failed = false;
  let timedOut = false;
  let failurePayload: unknown;

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        await host.cancelAgent(handle);
        break;
      }

      const next = await nextWithTimeout(iterator, remaining);
      if (next === TIMEOUT) {
        timedOut = true;
        await host.cancelAgent(handle);
        break;
      }
      if (next.done) break;

      events.push(next.value);
      if (next.value.type === "failed") {
        failed = true;
        failurePayload = next.value.payload;
        break;
      }
      if (next.value.type === "completed") {
        completed = true;
        break;
      }
    }
  } finally {
    await iterator.return?.();
  }

  return { completed, failed, timedOut, failurePayload, events };
}

const TIMEOUT = Symbol("host-agent-timeout");

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number
): Promise<IteratorResult<T> | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<typeof TIMEOUT>(resolve => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseManifest(raw: string): OutputManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid host output manifest JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.artifacts)) {
    throw new Error("Invalid host output manifest: expected { version: 1, artifacts: [] }");
  }

  const artifacts = value.artifacts.map((entry, index): OutputManifestArtifact => {
    if (!isRecord(entry)) throw new Error(`Invalid host output manifest artifact at index ${index}`);
    const logicalName = nonEmptyString(entry.logicalName, `artifacts[${index}].logicalName`);
    const path = nonEmptyString(entry.path, `artifacts[${index}].path`);
    const type = nonEmptyString(entry.type, `artifacts[${index}].type`);
    if (!ARTIFACT_TYPES.has(type as ArtifactType)) {
      throw new Error(`Unsupported artifact type in host output manifest: ${type}`);
    }
    const mimeType = entry.mimeType === undefined
      ? undefined
      : nonEmptyString(entry.mimeType, `artifacts[${index}].mimeType`);
    return {
      logicalName,
      path,
      type: type as ArtifactType,
      ...(mimeType ? { mimeType } : {})
    };
  });

  return { version: 1, artifacts };
}

function secureWorkspaceFile(workspaceRoot: string, declaredPath: string): string {
  if (isAbsolute(declaredPath)) {
    throw new Error(`Host output artifact path must be relative: ${declaredPath}`);
  }

  const lexical = resolve(workspaceRoot, declaredPath);
  assertWithin(workspaceRoot, lexical, declaredPath);
  if (!existsSync(lexical)) throw new Error(`Host output artifact does not exist: ${declaredPath}`);

  const workspaceReal = realpathSync(workspaceRoot);
  const fileReal = realpathSync(lexical);
  assertWithin(workspaceReal, fileReal, declaredPath);
  return fileReal;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new Error(`Host output artifact escapes workspace: ${label}`);
}

function writeHostEventLog(path: string, events: HostAgentEvent[]): void {
  writeFileSync(
    path,
    events.map(event => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""),
    "utf8"
  );
}

function outcome(
  executionId: string,
  state: ExecutionResult["state"],
  startedAt: string,
  logRef: string,
  producedFiles: ProducedFile[],
  artifacts: Artifact[]
): WorkExecutionOutcome {
  const result: ExecutionResult = {
    executionId,
    state,
    producedFiles,
    committedArtifactRefs: artifacts.map(artifact => `${artifact.id}@${artifact.version}`),
    logRef,
    sideEffects: [],
    startedAt,
    endedAt: new Date().toISOString()
  };
  return { result, artifacts };
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid host output manifest field ${label}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
