import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Artifact, ArtifactType } from "../../core/domain/artifact.ts";
import type { ExecutionResult, ExecutionRuntimeBinding } from "../../core/domain/execution.ts";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome,
  WorkRecoveryInput
} from "../../core/execution/work-execution-driver.ts";
import type { HostAdapter, HostAgentEvent, HostAgentHandle } from "../../hosts/deepseek/host-adapter.ts";
import { FileArtifactStore } from "../artifacts/artifact-store.ts";
import { WorkspaceManager } from "../workspace/workspace-manager.ts";

export const HOST_AGENT_OUTPUT_MANIFEST = ".mission-output.json";

export interface HostAgentWorkExecutionDriverOptions {
  manifestFileName?: string;
  maxManifestBytes?: number;
  hardTimeoutMs?: number;
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

interface ExecutionIdentityInput {
  workItem: WorkExecutionInput["workItem"];
  contextPacket: WorkExecutionInput["contextPacket"];
  attemptId: string;
  executionId: string;
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

export class HostAgentWorkExecutionDriver implements WorkExecutionDriver {
  readonly id = "host-agent-work-execution-driver";

  private readonly host: HostAdapter;
  private readonly workspaces: WorkspaceManager;
  private readonly artifacts: FileArtifactStore;
  private readonly manifestFileName: string;
  private readonly maxManifestBytes: number;
  private readonly hardTimeoutMs: number;
  private readonly inFlight = new Map<string, Promise<WorkExecutionOutcome>>();

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
    this.hardTimeoutMs = Math.max(1_000, options.hardTimeoutMs ?? 30 * 60_000);
  }

  isActive(executionId: string): boolean {
    return this.inFlight.has(executionId);
  }

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    const existing = this.inFlight.get(input.executionId);
    if (existing) return existing;
    const operation = this.executeNew(input);
    this.inFlight.set(input.executionId, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(input.executionId);
    }
  }

  async recover(input: WorkRecoveryInput): Promise<WorkExecutionOutcome> {
    const existing = this.inFlight.get(input.executionId);
    if (existing) return existing;
    const operation = this.recoverBound(input);
    this.inFlight.set(input.executionId, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(input.executionId);
    }
  }

  private async executeNew(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    const startedAt = new Date().toISOString();
    const workspace = this.workspaces.allocate(input.workItem.missionId, input.attemptId);
    const manifestPath = resolve(workspace.root, this.manifestFileName);
    const handle = await this.host.createAgent(this.agentRequest(input, workspace.root, manifestPath));

    const binding: ExecutionRuntimeBinding = {
      executionId: input.executionId,
      attemptId: input.attemptId,
      workItemId: input.workItem.id,
      driverId: this.id,
      hostHandleId: handle.id,
      ...(handle.nativeRef ? { nativeRef: handle.nativeRef } : {}),
      workspaceRoot: workspace.root,
      boundAt: new Date().toISOString()
    };
    await input.lifecycle?.bindRuntime(binding);

    return this.observeAndCollect(input, workspace.root, manifestPath, handle, startedAt, "host-agent-events.jsonl");
  }

  private async recoverBound(input: WorkRecoveryInput): Promise<WorkExecutionOutcome> {
    validateRecoveryBinding(this.id, input);
    const startedAt = new Date().toISOString();
    const workspace = this.workspaces.openExisting(input.workItem.missionId, input.attemptId);
    if (resolve(workspace.root) !== resolve(input.binding.workspaceRoot)) {
      throw new Error(
        `Recovered workspace does not match binding for ${input.executionId}: ` +
        `${input.binding.workspaceRoot} != ${workspace.root}`
      );
    }
    if (!input.binding.nativeRef) {
      return {
        result: executionResult({
          input,
          state: "lost",
          startedAt,
          logRef: resolve(workspace.root, "host-agent-recovery-events.jsonl"),
          runtimeObservationRef: "Execution binding has no host-native session reference"
        }),
        artifacts: []
      };
    }

    const manifestPath = resolve(workspace.root, this.manifestFileName);
    const resumed = await this.host.resumeAgent({
      ...this.agentRequest(input, workspace.root, manifestPath),
      handleId: input.binding.hostHandleId,
      nativeRef: input.binding.nativeRef
    });
    if (resumed.status !== "resumed") {
      return {
        result: executionResult({
          input,
          state: resumed.status === "failed" ? "failed" : "lost",
          startedAt,
          logRef: resolve(workspace.root, "host-agent-recovery-events.jsonl"),
          runtimeObservationRef: `Host session recovery ${resumed.status}: ${resumed.reason}`
        }),
        artifacts: []
      };
    }
    if (resumed.handle.id !== input.binding.hostHandleId || resumed.handle.nativeRef !== input.binding.nativeRef) {
      throw new Error(`Host resumed a different runtime identity for ${input.executionId}`);
    }

    return this.observeAndCollect(
      input,
      workspace.root,
      manifestPath,
      resumed.handle,
      startedAt,
      "host-agent-recovery-events.jsonl"
    );
  }

  private agentRequest(input: ExecutionIdentityInput, workspaceRoot: string, manifestPath: string) {
    return {
      missionId: input.workItem.missionId,
      workItemId: input.workItem.id,
      workspaceRoot,
      allowedCapabilityRefs: [...input.contextPacket.allowedCapabilityRefs],
      context: {
        contextPacket: input.contextPacket,
        executionContract: {
          workspaceRoot,
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
    };
  }

  private async observeAndCollect(
    input: ExecutionIdentityInput,
    workspaceRoot: string,
    manifestPath: string,
    handle: HostAgentHandle,
    startedAt: string,
    logFileName: string
  ): Promise<WorkExecutionOutcome> {
    let observed: HostObservation;
    try {
      observed = await observeHost(this.host, handle, this.hardTimeoutMs);
    } catch (error) {
      await safeCancel(this.host, handle);
      throw error;
    }

    const logRef = resolve(workspaceRoot, logFileName);
    writeFileSync(
      logRef,
      observed.events.map(event => JSON.stringify(event)).join("\n") + (observed.events.length ? "\n" : ""),
      "utf8"
    );

    if (observed.timedOut) {
      return { result: executionResult({ input, state: "timed_out", startedAt, logRef }), artifacts: [] };
    }
    if (observed.terminal === "failed") {
      return {
        result: executionResult({
          input,
          state: "failed",
          startedAt,
          logRef,
          runtimeObservationRef: observed.failurePayload === undefined
            ? undefined
            : JSON.stringify(observed.failurePayload)
        }),
        artifacts: []
      };
    }
    if (observed.terminal !== "completed") {
      return { result: executionResult({ input, state: "lost", startedAt, logRef }), artifacts: [] };
    }

    const committed = this.commitDeclaredOutputs(input, workspaceRoot, manifestPath);
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
    input: ExecutionIdentityInput,
    workspaceRoot: string,
    manifestPath: string
  ): Artifact[] {
    if (!existsSync(manifestPath)) return [];

    const manifestRealPath = resolveWorkspaceFile(workspaceRoot, this.manifestFileName);
    const info = statSync(manifestRealPath);
    if (!info.isFile()) throw new Error(`Host output manifest is not a file: ${manifestPath}`);
    if (info.size > this.maxManifestBytes) throw new Error(`Host output manifest exceeds ${this.maxManifestBytes} bytes`);

    const manifest = parseManifest(readFileSync(manifestRealPath, "utf8"));
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

interface HostObservation {
  terminal: "completed" | "failed" | null;
  timedOut: boolean;
  failurePayload?: unknown;
  events: HostAgentEvent[];
}

const TIMEOUT = Symbol("host-observation-timeout");

async function observeHost(
  host: HostAdapter,
  handle: HostAgentHandle,
  hardTimeoutMs: number
): Promise<HostObservation> {
  const iterator = host.observeAgent(handle)[Symbol.asyncIterator]();
  const deadline = Date.now() + hardTimeoutMs;
  const events: HostAgentEvent[] = [];
  let terminal: HostObservation["terminal"] = null;
  let timedOut = false;
  let failurePayload: unknown;

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        await safeCancel(host, handle);
        break;
      }

      const next = await nextWithTimeout(iterator, remaining);
      if (next === TIMEOUT) {
        timedOut = true;
        await safeCancel(host, handle);
        break;
      }
      if (next.done) break;

      events.push(next.value);
      if (next.value.type === "failed") {
        terminal = "failed";
        failurePayload = next.value.payload;
        break;
      }
      if (next.value.type === "completed") {
        terminal = "completed";
        break;
      }
    }
  } finally {
    if (timedOut) void iterator.return?.();
    else await iterator.return?.();
  }

  return { terminal, timedOut, failurePayload, events };
}

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
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateRecoveryBinding(driverId: string, input: WorkRecoveryInput): void {
  const binding = input.binding;
  if (binding.driverId !== driverId) throw new Error(`Recovery binding driver mismatch: ${binding.driverId}`);
  if (binding.executionId !== input.executionId) throw new Error(`Recovery binding execution mismatch: ${binding.executionId}`);
  if (binding.attemptId !== input.attemptId) throw new Error(`Recovery binding attempt mismatch: ${binding.attemptId}`);
  if (binding.workItemId !== input.workItem.id) throw new Error(`Recovery binding work item mismatch: ${binding.workItemId}`);
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

  const lexicalRoot = resolve(workspaceRoot);
  const lexical = resolve(lexicalRoot, declaredPath);
  assertWithin(lexicalRoot, lexical, declaredPath);
  if (!existsSync(lexical)) return lexical;

  const realRoot = realpathSync(lexicalRoot);
  const realCandidate = realpathSync(lexical);
  assertWithin(realRoot, realCandidate, declaredPath);
  return realCandidate;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`Host output path escapes workspace: ${label}`);
  }
}

function validateManifestFileName(value: string): string {
  if (!value || isAbsolute(value) || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw new Error(`Manifest file name must be a single relative file name: ${value}`);
  }
  return value;
}

function executionResult(input: {
  input: ExecutionIdentityInput;
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

async function safeCancel(host: HostAdapter, handle: HostAgentHandle): Promise<void> {
  try {
    await host.cancelAgent(handle);
  } catch {
    // Preserve the primary observation/transport error.
  }
}
