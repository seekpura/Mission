import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Artifact, ArtifactType } from "../../core/domain/artifact.ts";
import type { ExecutionResult } from "../../core/domain/execution.ts";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome
} from "../../core/execution/work-execution-driver.ts";
import type { HostAdapter, HostAgentEvent } from "../../hosts/deepseek/host-adapter.ts";
import { FileArtifactStore } from "../artifacts/artifact-store.ts";
import { WorkspaceManager } from "../workspace/workspace-manager.ts";

export const HOST_AGENT_OUTPUT_MANIFEST = ".mission-output.json";

export interface HostAgentWorkExecutionDriverOptions {
  manifestFileName?: string;
  maxManifestBytes?: number;
}

interface OutputManifestEntry {
  path: string;
  logicalName: string;
  type: ArtifactType;
  mimeType?: string;
}

interface OutputManifest {
  outputs: OutputManifestEntry[];
}

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

/**
 * Production WorkExecutionDriver for any HostAdapter that can create/observe a
 * native agent. The agent works inside a Mission-owned workspace and declares
 * concrete output files through a small manifest. Mission validates paths and
 * commits the real files into FileArtifactStore; agent text is never treated as
 * artifact truth.
 */
export class HostAgentWorkExecutionDriver implements WorkExecutionDriver {
  readonly id = "host-agent-work-execution-driver";

  private readonly host: HostAdapter;
  private readonly workspaces: WorkspaceManager;
  private readonly artifacts: FileArtifactStore;
  private readonly manifestFileName: string;
  private readonly maxManifestBytes: number;

  constructor(
    host: HostAdapter,
    workspaces: WorkspaceManager,
    artifacts: FileArtifactStore,
    options: HostAgentWorkExecutionDriverOptions = {}
  ) {
    this.host = host;
    this.workspaces = workspaces;
    this.artifacts = artifacts;
    this.manifestFileName = validateManifestFileName(options.manifestFileName ?? HOST_AGENT_OUTPUT_MANIFEST);
    this.maxManifestBytes = Math.max(1_024, options.maxManifestBytes ?? 1_048_576);
  }

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    const startedAt = new Date().toISOString();
    const workspace = this.workspaces.allocate(input.workItem.missionId, input.attemptId);
    const manifestPath = resolve(workspace.root, this.manifestFileName);
    const events: HostAgentEvent[] = [];

    const handle = await this.host.createAgent({
      missionId: input.workItem.missionId,
      workItemId: input.workItem.id,
      workspaceRoot: workspace.root,
      allowedCapabilityRefs: [...input.contextPacket.allowedCapabilityRefs],
      context: {
        contextPacket: input.contextPacket,
        executionContract: {
          workspaceRoot: workspace.root,
          outputManifest: {
            path: manifestPath,
            format: {
              outputs: [
                {
                  path: "relative/path/inside/workspace.ext",
                  logicalName: "stable-logical-name",
                  type: "file | document | presentation | image | video | audio | code | website | dataset | research | other",
                  mimeType: "optional MIME type"
                }
              ]
            },
            expectedOutputs: input.workItem.expectedOutputs.map(output => ({ ...output }))
          },
          rules: [
            "Write all deliverables inside workspaceRoot.",
            "Before completing, write the output manifest as valid JSON at outputManifest.path.",
            "Manifest paths must be relative to workspaceRoot and must name real files.",
            "Do not claim an artifact exists only in chat text; Mission accepts only committed files."
          ]
        }
      }
    });

    let terminal: "completed" | "failed" | null = null;
    let failurePayload: unknown;
    try {
      for await (const event of this.host.observeAgent(handle)) {
        events.push(event);
        if (event.type === "failed") {
          terminal = "failed";
          failurePayload = event.payload;
          break;
        }
        if (event.type === "completed") {
          terminal = "completed";
          break;
        }
      }
    } catch (error) {
      await safeCancel(this.host, handle);
      throw error;
    }

    const logRef = resolve(workspace.root, "host-agent-events.jsonl");
    writeFileSync(logRef, events.map(event => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), "utf8");

    if (terminal === "failed") {
      return {
        result: executionResult({
          input,
          state: "failed",
          startedAt,
          logRef,
          runtimeObservationRef: failurePayload === undefined ? undefined : JSON.stringify(failurePayload)
        }),
        artifacts: []
      };
    }

    if (terminal !== "completed") {
      return {
        result: executionResult({ input, state: "lost", startedAt, logRef }),
        artifacts: []
      };
    }

    const committed = this.commitDeclaredOutputs(input, workspace.root, manifestPath);
    return {
      result: executionResult({
        input,
        state: "succeeded",
        startedAt,
        logRef,
        producedFiles: committed.map(artifact => ({
          path: artifact.uri,
          logicalName: artifact.logicalName,
          type: artifact.type
        })),
        committedArtifactRefs: committed.map(artifact => `${artifact.id}@${artifact.version}`)
      }),
      artifacts: committed
    };
  }

  private commitDeclaredOutputs(
    input: WorkExecutionInput,
    workspaceRoot: string,
    manifestPath: string
  ): Artifact[] {
    if (!existsSync(manifestPath)) return [];

    const info = statSync(manifestPath);
    if (!info.isFile()) throw new Error(`Host output manifest is not a file: ${manifestPath}`);
    if (info.size > this.maxManifestBytes) {
      throw new Error(`Host output manifest exceeds ${this.maxManifestBytes} bytes`);
    }

    const manifest = parseManifest(readFileSync(manifestPath, "utf8"));
    const expectedByName = new Map(input.workItem.expectedOutputs.map(output => [output.logicalName, output]));
    const seenLogicalNames = new Set<string>();
    const committed: Artifact[] = [];

    for (const entry of manifest.outputs) {
      if (seenLogicalNames.has(entry.logicalName)) {
        throw new Error(`Duplicate logicalName in host output manifest: ${entry.logicalName}`);
      }
      seenLogicalNames.add(entry.logicalName);

      const expected = expectedByName.get(entry.logicalName);
      if (expected && expected.type && expected.type !== entry.type) {
        throw new Error(
          `Host output type mismatch for ${entry.logicalName}: expected ${expected.type}, received ${entry.type}`
        );
      }

      const sourcePath = resolveWorkspaceFile(workspaceRoot, entry.path);
      if (!existsSync(sourcePath)) throw new Error(`Declared host output does not exist: ${entry.path}`);
      if (!statSync(sourcePath).isFile()) throw new Error(`Declared host output is not a file: ${entry.path}`);

      committed.push(this.artifacts.commit({
        missionId: input.workItem.missionId,
        logicalName: entry.logicalName,
        type: entry.type,
        sourcePath,
        producedByAttemptId: input.attemptId,
        sourceArtifactRefs: [...input.workItem.inputArtifactRefs],
        ...(entry.mimeType ? { mimeType: entry.mimeType } : {})
      }));
    }

    return committed;
  }
}

function parseManifest(raw: string): OutputManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid host output manifest JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { outputs?: unknown }).outputs)) {
    throw new Error("Invalid host output manifest: outputs must be an array");
  }

  const outputs = (parsed as { outputs: unknown[] }).outputs.map((value, index): OutputManifestEntry => {
    if (!value || typeof value !== "object") throw new Error(`Invalid host output manifest entry at index ${index}`);
    const entry = value as Record<string, unknown>;
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Error(`Invalid host output path at index ${index}`);
    }
    if (typeof entry.logicalName !== "string" || entry.logicalName.length === 0) {
      throw new Error(`Invalid host output logicalName at index ${index}`);
    }
    if (typeof entry.type !== "string" || !ARTIFACT_TYPES.has(entry.type as ArtifactType)) {
      throw new Error(`Invalid host output artifact type at index ${index}: ${String(entry.type)}`);
    }
    if (entry.mimeType !== undefined && typeof entry.mimeType !== "string") {
      throw new Error(`Invalid host output mimeType at index ${index}`);
    }
    return {
      path: entry.path,
      logicalName: entry.logicalName,
      type: entry.type as ArtifactType,
      ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {})
    };
  });

  return { outputs };
}

function resolveWorkspaceFile(workspaceRoot: string, declaredPath: string): string {
  if (isAbsolute(declaredPath)) throw new Error(`Host output path must be relative: ${declaredPath}`);
  const resolved = resolve(workspaceRoot, declaredPath);
  const rel = relative(resolve(workspaceRoot), resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Host output path escapes workspace: ${declaredPath}`);
  }
  return resolved;
}

function validateManifestFileName(value: string): string {
  if (!value || isAbsolute(value) || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error(`Manifest file name must be a single relative file name: ${value}`);
  }
  return value;
}

function executionResult(input: {
  input: WorkExecutionInput;
  state: ExecutionResult["state"];
  startedAt: string;
  logRef: string;
  producedFiles?: ExecutionResult["producedFiles"];
  committedArtifactRefs?: string[];
  runtimeObservationRef?: string;
}): ExecutionResult {
  return {
    executionId: input.input.executionId,
    state: input.state,
    producedFiles: input.producedFiles ?? [],
    committedArtifactRefs: input.committedArtifactRefs ?? [],
    ...(input.runtimeObservationRef ? { runtimeObservationRef: input.runtimeObservationRef } : {}),
    logRef: input.logRef,
    sideEffects: [],
    startedAt: input.startedAt,
    endedAt: new Date().toISOString()
  };
}

async function safeCancel(host: HostAdapter, handle: { id: string; nativeRef?: string }): Promise<void> {
  try {
    await host.cancelAgent(handle);
  } catch {
    // Preserve the primary observation/transport error.
  }
}
