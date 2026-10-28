import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { ArtifactType } from "../../core/domain/artifact.ts";
import type {
  SideEffectAdmission,
  SideEffectCompletion,
  SideEffectIntent,
  SideEffectPolicy,
  SideEffectRecord
} from "../../core/domain/execution.ts";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome
} from "../../core/execution/work-execution-driver.ts";
import { LocalExecutionBackend, type LocalCommandExecutionRequest } from "./local-execution-backend.ts";

export interface TrustedLocalCommandPlan {
  trust: "trusted-host-process";
  rationale: string;
  command: string;
  args: string[];
  outputFiles: Array<{ path: string; logicalName: string; type: ArtifactType }>;
  allowedEnvKeys?: string[];
  hardTimeoutMs?: number;
  sideEffectPolicy?: SideEffectPolicy;
}

export interface TrustedLocalCommandPlanner {
  plan(input: WorkExecutionInput): Promise<TrustedLocalCommandPlan>;
}

export interface LocalCommandSideEffectBoundary {
  authorize(intent: SideEffectIntent, policy: SideEffectPolicy): Promise<{
    intent: SideEffectIntent;
    admission: SideEffectAdmission;
  }>;
  complete(
    intent: SideEffectIntent,
    status: SideEffectCompletion["status"],
    detail?: string
  ): Promise<SideEffectCompletion>;
}

const DEFAULT_LOCAL_SIDE_EFFECT_POLICY: SideEffectPolicy = {
  externalWrites: "approval",
  destructiveWrites: "approval",
  irreversibleActions: "approval",
  idempotencyRequired: true
};

/**
 * Adapts LocalExecutionBackend to the generic WorkExecutionDriver boundary.
 *
 * This is intentionally an explicit trusted-host-process path. The current
 * LocalExecutionBackend provides cwd/env/timeout boundaries but is not an OS
 * sandbox: the spawned process can potentially access host filesystem/network
 * according to the operating-system account. Runtime therefore treats every
 * such process as an unknown side effect and requires durable admission before
 * spawning it. A trusted plan is necessary, but is not itself authorization.
 */
export class LocalCommandWorkExecutionDriver implements WorkExecutionDriver {
  readonly id = "local-command-work-execution-driver";
  private readonly backend: LocalExecutionBackend;
  private readonly planner: TrustedLocalCommandPlanner;
  private readonly sideEffects: LocalCommandSideEffectBoundary;

  constructor(
    backend: LocalExecutionBackend,
    planner: TrustedLocalCommandPlanner,
    sideEffects: LocalCommandSideEffectBoundary
  ) {
    this.backend = backend;
    this.planner = planner;
    this.sideEffects = sideEffects;
  }

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    const plan = await this.planner.plan(input);
    validatePlan(plan);
    const policy = { ...(plan.sideEffectPolicy ?? DEFAULT_LOCAL_SIDE_EFFECT_POLICY) };
    const intent = localCommandIntent(input, plan);
    const authorization = await this.sideEffects.authorize(intent, policy);
    if (authorization.admission.status !== "admitted") {
      const now = new Date().toISOString();
      return {
        result: {
          executionId: input.executionId,
          state: "failed",
          producedFiles: [],
          committedArtifactRefs: [],
          runtimeObservationRef: `Local command side effect ${authorization.admission.status}: ${authorization.admission.reason}`,
          sideEffects: [admissionRecord(authorization.intent, authorization.admission)],
          startedAt: now,
          endedAt: now
        },
        artifacts: []
      };
    }

    const request: LocalCommandExecutionRequest = {
      executionId: input.executionId,
      missionId: input.workItem.missionId,
      workItemId: input.workItem.id,
      attemptId: input.attemptId,
      executor: { id: this.id, type: "cli" },
      contextPacketId: input.contextPacket.id,
      inputArtifactRefs: [...input.workItem.inputArtifactRefs],
      expectedOutputs: input.workItem.expectedOutputs.map(output => ({ ...output })),
      capabilityRefs: [...input.contextPacket.allowedCapabilityRefs],
      workspacePolicy: { type: "filesystem", lifecycle: "ephemeral" },
      isolationPolicy: {
        level: "host",
        networkIsolation: false,
        filesystemIsolation: false,
        processIsolation: false,
        secretIsolation: false
      },
      permissionEnvelope: {
        filesystemRead: ["*"],
        filesystemWrite: ["*"],
        network: "allow",
        networkHosts: [],
        allowedEnvKeys: [...(plan.allowedEnvKeys ?? [])],
        subprocess: true,
        packageInstall: true,
        secrets: "scoped",
        hostMutation: true
      },
      timeoutPolicy: { hardTimeoutMs: plan.hardTimeoutMs },
      retryPolicy: { runtimeRetries: 0 },
      sideEffectPolicy: policy,
      localCommand: {
        command: plan.command,
        args: [...plan.args]
      },
      outputFiles: plan.outputFiles.map(output => ({ ...output }))
    };

    const handle = await this.backend.allocate(request);
    await this.backend.start(handle);
    try {
      const outcome = await this.backend.collectOutcome(handle);
      const completion = await this.sideEffects.complete(
        authorization.intent,
        outcome.result.state === "succeeded" ? "succeeded" : "unknown",
        `Local command execution finished with state ${outcome.result.state}`
      );
      outcome.result.sideEffects = [
        ...outcome.result.sideEffects,
        completionRecord(authorization.intent, completion, outcome.result.state)
      ];
      return outcome;
    } catch (error) {
      await this.sideEffects.complete(
        authorization.intent,
        "unknown",
        `Local command execution threw before a terminal outcome: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }
}

function validatePlan(plan: TrustedLocalCommandPlan): void {
  if (plan.trust !== "trusted-host-process") {
    throw new Error("Local command execution requires explicit trusted-host-process admission");
  }
  if (!plan.rationale.trim()) {
    throw new Error("Trusted local command plan requires a rationale");
  }
  if (!plan.command.trim()) {
    throw new Error("Trusted local command plan requires a command");
  }
  if (!Array.isArray(plan.args)) {
    throw new Error("Trusted local command plan args must be an array");
  }
  const logicalNames = new Set<string>();
  for (const output of plan.outputFiles) {
    if (!output.path || !output.logicalName) {
      throw new Error("Trusted local command output requires path and logicalName");
    }
    if (logicalNames.has(output.logicalName)) {
      throw new Error(`Duplicate trusted local output logicalName: ${output.logicalName}`);
    }
    logicalNames.add(output.logicalName);
  }
}

function localCommandIntent(input: WorkExecutionInput, plan: TrustedLocalCommandPlan): SideEffectIntent {
  const operationKey = `local-command:${input.workItem.missionId}:${input.workItem.id}:${input.attemptId}`;
  const digest = createHash("sha256").update(operationKey).digest("hex");
  const commandName = basename(plan.command) || "local-command";
  return {
    id: `side-effect:${digest.slice(0, 32)}`,
    missionId: input.workItem.missionId,
    workItemId: input.workItem.id,
    attemptId: input.attemptId,
    executionId: input.executionId,
    source: "local-command",
    operationKey,
    fingerprint: createHash("sha256").update(stableJson({
      command: plan.command,
      args: plan.args,
      allowedEnvKeys: plan.allowedEnvKeys ?? [],
      outputFiles: plan.outputFiles
    })).digest("hex"),
    effectClass: "unknown-effect",
    type: "system-change",
    target: `local-process:${commandName}`,
    reversible: false,
    description: `Trusted local host process ${commandName} can have effects outside the Mission workspace and requires Runtime admission`,
    createdAt: new Date().toISOString(),
    metadata: { commandName }
  };
}

function admissionRecord(intent: SideEffectIntent, admission: SideEffectAdmission): SideEffectRecord {
  return {
    type: intent.type,
    target: intent.target,
    reversible: intent.reversible,
    result: admission.reason,
    intentId: intent.id,
    operationKey: intent.operationKey,
    effectClass: intent.effectClass,
    status: admission.status
  };
}

function completionRecord(
  intent: SideEffectIntent,
  completion: SideEffectCompletion,
  executionState: string
): SideEffectRecord {
  return {
    type: intent.type,
    target: intent.target,
    reversible: intent.reversible,
    result: executionState,
    intentId: intent.id,
    operationKey: intent.operationKey,
    effectClass: intent.effectClass,
    status: completion.status
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}
