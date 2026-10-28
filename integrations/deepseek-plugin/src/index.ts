import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { brandString } from "@deepseek-ai/dsh-brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { CapabilityDescriptor } from "../../../src/core/domain/capability.ts";
import { HostDeliberationProvider } from "../../../src/core/planning/host-deliberation-provider.ts";
import { DeepSeekHarnessAdapter } from "../../../src/hosts/deepseek/deepseek-host-adapter.ts";
import { OfficialDeepSeekBindings } from "../../../src/hosts/deepseek/official-bindings.ts";
import { MissionRuntime } from "../../../src/runtime/mission-runtime.ts";

export const name = "mission-runtime";
export const inject = ["agents", "tools"];

const DSH_API_TARGET = "deepseek-ai/deepseek-harness@22ddee3792402c3e70ec5f86a63c3e3e895a2f60";

export function apply(ctx: Context): void {
  const bindings = new OfficialDeepSeekBindings(ctx as any, {
    version: DSH_API_TARGET,
    createUserMessage,
    capabilities: () => hostCapabilities(ctx),
    summarizeAgent: agent => summarizeAgent(agent as unknown as Agent),
    invokeCapability: request => invokeHostTool(ctx, request.capabilityId, request.input),
    shellAvailable: true,
    filesystemAvailable: true,
    browserAvailable: ctx.tools.schemas().some(tool => /browser|web|computer/i.test(tool.name))
  });
  const host = new DeepSeekHarnessAdapter(bindings);
  const deliberation = new HostDeliberationProvider(host);
  const runtime = new MissionRuntime({ deliberation, host });

  ctx.effect(() => () => runtime.close(), "mission-runtime.close()");

  ctx.tools.register(defineTool({
    name: "mission_start",
    description: "Start a durable autonomous Mission from an end goal. Mission plans progressively instead of requiring a fixed workflow.",
    parameters: {
      goal: { type: "string", required: true, description: "The final user goal the Mission must satisfy." }
    },
    output: stringOutput(),
    async execute(args) {
      const missionId = `mission-${randomUUID()}`;
      await runtime.controller.createMission(missionId, args.goal);
      const env = await host.snapshotEnvironment();
      await runtime.controller.emit(missionId, "environment.snapshot.created", env, { type: "host" }, `environment:${missionId}:${env.revision}`);
      await runtime.controller.runControllerCycle({ missionId, trigger: "mission_created" });
      runtime.orchestrator?.wake(missionId);
      await runtime.checkpoint(missionId);
      return missionView(runtime, missionId);
    }
  }));

  ctx.tools.register(defineTool({
    name: "mission_status",
    description: "Read the durable current state, work frontier, and open gaps of a Mission.",
    parameters: {
      mission_id: { type: "string", required: true, description: "Mission id returned by mission_start." }
    },
    output: stringOutput(),
    async execute(args) {
      return missionView(runtime, args.mission_id);
    }
  }));

  ctx.tools.register(defineTool({
    name: "mission_steer",
    description: "Steer an existing Mission without restarting unaffected work. The steering becomes a durable Mission event.",
    parameters: {
      mission_id: { type: "string", required: true },
      message: { type: "string", required: true, description: "New user direction, constraint, priority, or correction." }
    },
    output: stringOutput(),
    async execute(args) {
      await runtime.steer(args.mission_id, args.message);
      await runtime.checkpoint(args.mission_id);
      return missionView(runtime, args.mission_id);
    }
  }));

  ctx.tools.register(defineTool({
    name: "mission_cycle",
    description: "Advance one event-driven Mission control cycle. Intended for operator/debug use while the full autonomous dispatcher is composed.",
    parameters: {
      mission_id: { type: "string", required: true }
    },
    output: stringOutput(),
    async execute(args) {
      const cycle = await runtime.controller.runControllerCycle({ missionId: args.mission_id, trigger: "manual" });
      await runtime.orchestrator?.runUntilQuiescent(args.mission_id);
      await runtime.checkpoint(args.mission_id);
      return JSON.stringify({ cycle, ...(JSON.parse(await missionView(runtime, args.mission_id)) as object) });
    }
  }));
}

function stringOutput() {
  return {
    schema: { type: "string" as const },
    render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }]
  };
}

async function missionView(runtime: MissionRuntime, missionId: string): Promise<string> {
  const [state, work, gaps, contract, requirements, artifacts, evidence, acceptance] = await Promise.all([
    runtime.controller.state(missionId),
    runtime.projections.listWorkItems(missionId),
    runtime.projections.listGaps(missionId),
    runtime.projections.getAcceptanceContract(missionId),
    runtime.projections.listRequirements(missionId),
    runtime.projections.listArtifacts(missionId),
    runtime.projections.listEvidence(missionId),
    runtime.controller.acceptanceEvaluation(missionId)
  ]);
  return JSON.stringify({ missionId, state, acceptanceContract: contract, requirements, acceptance, work, gaps, artifacts, evidence });
}

function hostCapabilities(ctx: Context): CapabilityDescriptor[] {
  return ctx.tools.schemas()
    .filter(tool => !tool.name.startsWith("mission_"))
    .map(tool => ({
      id: `dsh-tool:${tool.name}`,
      kind: "tool" as const,
      name: tool.name,
      description: tool.description ?? "DeepSeek Harness tool",
      hostNative: true,
      available: true,
      invocationRef: tool.name,
      permissions: [],
      scope: "host" as const
    }));
}

async function invokeHostTool(ctx: Context, capabilityId: string, input: unknown) {
  const name = capabilityId.startsWith("dsh-tool:") ? capabilityId.slice("dsh-tool:".length) : capabilityId;
  const batch = await ctx.tools.execute({
    calls: [{
      type: "tool-call",
      id: brandString<ToolCallId>(`mission-${randomUUID()}`),
      name,
      arguments: JSON.stringify(input ?? {})
    }],
    signal: new AbortController().signal
  });
  const result = batch.results[0]?.result;
  if (!result) return { ok: false, error: `Harness tool ${name} returned no result` };
  if (result.isError) {
    const text = result.content.map(block => block.type === "text" ? block.text : "").join("");
    return { ok: false, error: text || `Harness tool ${name} failed` };
  }
  return { ok: true, output: result.value };
}

function summarizeAgent(agent: Agent): string {
  let text = "";
  const length = Number(agent.session.seq);
  for (let index = 0; index < length; index++) {
    const event = agent.session.eventAt(SessionSeq(index));
    if (event?.type !== "assistant/message") continue;
    const candidate = event.data.message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("");
    if (candidate) text = candidate;
  }
  return text;
}
