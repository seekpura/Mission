import type { ArtifactType } from "../../core/domain/artifact.ts";
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
}

export interface TrustedLocalCommandPlanner {
  plan(input: WorkExecutionInput): Promise<TrustedLocalCommandPlan>;
}

/**
 * Adapts LocalExecutionBackend to the generic WorkExecutionDriver boundary.
 *
 * This is intentionally an explicit trusted-host-process path. The current
 * LocalExecutionBackend provides cwd/env/timeout boundaries but is not an OS
 * sandbox: the spawned process can potentially access host filesystem/network
 * according to the operating-system account. Callers must therefore supply a
 * TrustedLocalCommandPlanner that only emits pre-audited commands.
 */
export class LocalCommandWorkExecutionDriver implements WorkExecutionDriver {
  readonly id = "local-command-work-execution-driver";
  private readonly backend: LocalExecutionBackend;
  private readonly planner: TrustedLocalCommandPlanner;

  constructor(
    backend: LocalExecutionBackend,
    planner: TrustedLocalCommandPlanner
  ) {
    this.backend = backend;
    this.planner = planner;
  }

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    const plan = await this.planner.plan(input);
    validatePlan(plan);

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
      sideEffectPolicy: {
        externalWrites: "allow",
        destructiveWrites: "approval",
        irreversibleActions: "approval",
        idempotencyRequired: false
      },
      localCommand: {
        command: plan.command,
        args: [...plan.args]
      },
      outputFiles: plan.outputFiles.map(output => ({ ...output }))
    };

    const handle = await this.backend.allocate(request);
    await this.backend.start(handle);
    return this.backend.collectOutcome(handle);
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
