import { randomUUID } from "node:crypto";
import type { Artifact } from "../core/domain/artifact.ts";
import type {
  CapabilityCostClass,
  CapabilityDescriptor,
  CapabilityExecutionMode,
  CapabilityKind,
  CapabilityNeed,
  CapabilityNeedPolicy,
  CapabilityProvenance,
  RiskLevel
} from "../core/domain/capability.ts";
import type { MissionState } from "../core/domain/mission.ts";
import type { ArtifactExpectation, LocalAcceptanceCriterion, WorkItem, WorkPurpose } from "../core/domain/work-item.ts";
import type { Gap } from "../core/domain/verification.ts";
import { buildHostCapabilityGraph, type HostCapabilityGraph } from "../core/capabilities/capability-graph.ts";
import type { EventStore } from "../core/events/event-store.ts";
import { projectMissionJournal } from "../core/mission/journal-view.ts";
import type { MissionReadModelReader } from "../core/mission/mission-reader.ts";
import type {
  CompletionChallenge,
  DeliberationProvider,
  FrontierProposal,
  GapDiagnosis,
  StrategyProposal
} from "../core/planning/deliberation-provider.ts";
import type { HostAdapter } from "../hosts/host-adapter.ts";
import type { HostJsonTransport } from "./host-agent-json-transport.ts";

export interface HostDeliberationProviderOptions {
  transport: HostJsonTransport;
  events: EventStore;
  reader?: MissionReadModelReader;
  host?: HostAdapter;
  knownExecutorIds: string[];
  defaultExecutorId?: string;
  maxFrontierWorkItems?: number;
  maxCapabilityNeeds?: number;
}

interface DurablePlannerContext {
  missionId: string;
  userGoal: string;
  strategy?: StrategyProposal;
  capabilityNeeds: CapabilityNeed[];
  capabilities: CapabilityDescriptor[];
  workItems: WorkItem[];
  artifacts: Artifact[];
  openGaps: Gap[];
}

type KnownMonetaryClass = Exclude<CapabilityCostClass, "unknown">;

const WORK_PURPOSES = new Set<WorkPurpose>([
  "exploration", "production", "verification", "repair", "acquisition", "integration"
]);
const NEED_PURPOSES = new Set<CapabilityNeed["purpose"]>(["production", "verification", "research", "integration"]);
const NEED_URGENCY = new Set<CapabilityNeed["urgency"]>(["blocking", "high-value", "optional-improvement"]);
const RISK_LEVELS = new Set<RiskLevel>(["low", "medium", "high", "blocked"]);
const CAPABILITY_KINDS = new Set<CapabilityKind>([
  "skill", "tool", "mcp", "agent", "runtime", "library", "cli", "application", "workflow"
]);
const CAPABILITY_EXECUTION_MODES = new Set<CapabilityExecutionMode>([
  "host-agent", "host-capability", "mission-context", "local-process", "remote-service", "library"
]);
const CAPABILITY_PROVENANCE_SOURCES = new Set<CapabilityProvenance["source"]>([
  "host", "mission", "trusted-cache", "external"
]);
const CAPABILITY_MONETARY_CLASSES = new Set<KnownMonetaryClass>([
  "negligible", "low", "medium", "high"
]);
const CAPABILITY_NEED_POLICY_KEYS = new Set([
  "acceptableKinds",
  "requiredExecutionModes",
  "forbiddenPermissions",
  "acceptableProviders",
  "requiredNativeFeatures",
  "acceptableProvenanceSources",
  "maxMonetaryClass"
]);
const GAP_INTERVENTIONS = new Set<GapDiagnosis["intervention"]>([
  "retry", "revise_work", "replace_capability", "replan_local", "revise_strategy"
]);

export class HostDeliberationProvider implements DeliberationProvider {
  private readonly transport: HostJsonTransport;
  private readonly events: EventStore;
  private readonly reader?: MissionReadModelReader;
  private readonly host?: HostAdapter;
  private readonly knownExecutorIds: Set<string>;
  private readonly defaultExecutorId?: string;
  private readonly maxFrontierWorkItems: number;
  private readonly maxCapabilityNeeds: number;

  constructor(options: HostDeliberationProviderOptions) {
    this.transport = options.transport;
    this.events = options.events;
    this.reader = options.reader;
    this.host = options.host;
    this.knownExecutorIds = new Set(options.knownExecutorIds);
    this.defaultExecutorId = options.defaultExecutorId;
    this.maxFrontierWorkItems = Math.max(1, options.maxFrontierWorkItems ?? 8);
    this.maxCapabilityNeeds = Math.max(1, options.maxCapabilityNeeds ?? 8);
    if (this.knownExecutorIds.size === 0) throw new Error("HostDeliberationProvider requires at least one executor route");
    if (this.defaultExecutorId && !this.knownExecutorIds.has(this.defaultExecutorId)) {
      throw new Error(`Unknown default deliberation executor: ${this.defaultExecutorId}`);
    }
  }

  async composeStrategy(input: { state: MissionState; userGoal: string }): Promise<StrategyProposal> {
    const raw = await this.transport.request({
      missionId: input.state.missionId,
      operationId: `strategy-${input.state.revision}`,
      instruction: [
        "Create the current Mission strategy, not a complete task list.",
        "Preserve the user's final goal. Choose a progressive approach that can adapt after execution and verification evidence.",
        "Return JSON with: framing:string, approach:string, workstreams:[{id?:string, objective:string}], revision:number.",
        "Do not claim work is complete and do not include execution instructions outside the JSON schema."
      ].join(" "),
      input: {
        userGoal: input.userGoal,
        state: compactState(input.state)
      }
    });
    const object = objectValue(raw, "strategy");
    const workstreams = arrayValue(object.workstreams, "strategy.workstreams").map((value, index) => {
      const item = objectValue(value, `strategy.workstreams[${index}]`);
      return {
        id: optionalNonEmptyString(item.id) ?? `workstream:${randomUUID()}`,
        objective: nonEmptyString(item.objective, `strategy.workstreams[${index}].objective`)
      };
    });
    return {
      framing: nonEmptyString(object.framing, "strategy.framing"),
      approach: nonEmptyString(object.approach, "strategy.approach"),
      workstreams,
      revision: Math.max(1, integerValue(object.revision, "strategy.revision"))
    };
  }

  async planFrontier(input: { state: MissionState; openGaps: Gap[] }): Promise<FrontierProposal> {
    const context = await this.context(input.state.missionId);
    const hostCapabilityGraph = await this.capabilityGraph(context);
    const raw = await this.transport.request({
      missionId: input.state.missionId,
      operationId: `frontier-${input.state.revision}`,
      instruction: [
        "Plan only the next executable Mission frontier. Do not expand the entire mission into a fixed plan.",
        "Use existing evidence, completed/failed work and open gaps. Repair blocking gaps before unrelated expansion when appropriate.",
        "Use hostCapabilityGraph as the source of truth for currently available capability semantics, constraints, permissions, routing, cost and provider-native behavior.",
        "Prefer an already-available compatible capability when its graph constraints are satisfied. Create a CapabilityNeed only when required semantics are missing or materially inadequate; do not infer capability behavior from a name alone.",
        `Valid executor ids are: ${[...this.knownExecutorIds].join(", ")}.`,
        this.defaultExecutorId ? `If no special route is needed, assignedExecutorId may be omitted and Runtime will use ${this.defaultExecutorId}.` : "Every executable work item must name assignedExecutorId.",
        "Return JSON with graphRevision:number, capabilityNeeds:array, workItems:array.",
        "Each capability need may contain id?, objective, requiredFunctions[], desiredInputs[], desiredOutputs[], purpose, urgency, acquisitionAllowed, maxRisk, policy?, requirementRefs[], gapRefs[]. If policy is present, its only allowed keys are acceptableKinds[], requiredExecutionModes[], forbiddenPermissions[], acceptableProviders[], requiredNativeFeatures[], acceptableProvenanceSources[], maxMonetaryClass.",
        "Each work item may contain id?, workstreamId?, parentWorkItemId?, purpose, objective, requirementRefs[], gapRefs[], inputArtifactRefs[], expectedOutputs:[{logicalName,type,required}], localAcceptanceCriteria:[{id?,description,priority}], capabilityNeedRefs[], assignedExecutorId?, priority.",
        "Do not set missionId, status, graphRevision, createdBy or timestamps; Runtime owns those fields."
      ].join(" "),
      input: {
        mission: plannerContext(context, input.state),
        hostCapabilityGraph: hostCapabilityGraph ? plannerCapabilityGraph(hostCapabilityGraph) : undefined,
        openGaps: input.openGaps
      }
    });

    const object = objectValue(raw, "frontier");
    const graphRevision = Math.max(input.state.graphRevision + 1, integerValue(object.graphRevision, "frontier.graphRevision"));
    const needValues = arrayValue(object.capabilityNeeds ?? [], "frontier.capabilityNeeds");
    if (needValues.length > this.maxCapabilityNeeds) {
      throw new Error(`Planner frontier exceeds capability need limit ${this.maxCapabilityNeeds}`);
    }
    const capabilityNeeds = needValues.map((value, index) => this.normalizeCapabilityNeed(
      value,
      input.state.missionId,
      `frontier.capabilityNeeds[${index}]`
    ));
    assertUnique(capabilityNeeds.map(need => need.id), "capability need id");

    const workValues = arrayValue(object.workItems, "frontier.workItems");
    if (workValues.length > this.maxFrontierWorkItems) {
      throw new Error(`Planner frontier exceeds work item limit ${this.maxFrontierWorkItems}`);
    }
    const knownNeedIds = new Set([
      ...context.capabilityNeeds.map(need => need.id),
      ...capabilityNeeds.map(need => need.id)
    ]);
    const knownGapIds = new Set(context.openGaps.map(gap => gap.id));
    const knownArtifactRefs = new Set(context.artifacts.map(artifact => `${artifact.id}@${artifact.version}`));
    const now = new Date().toISOString();
    const createdBy: WorkItem["createdBy"] = input.openGaps.length > 0 ? "replanner" : "planner";
    const workItems = workValues.map((value, index) => this.normalizeWorkItem({
      value,
      path: `frontier.workItems[${index}]`,
      missionId: input.state.missionId,
      graphRevision,
      now,
      createdBy,
      knownNeedIds,
      knownGapIds,
      knownArtifactRefs
    }));
    assertUnique(workItems.map(work => work.id), "work item id");

    return { workItems, capabilityNeeds, graphRevision };
  }

  async diagnoseGap(input: { state: MissionState; gap: Gap }): Promise<GapDiagnosis> {
    const context = await this.context(input.state.missionId);
    const hostCapabilityGraph = await this.capabilityGraph(context);
    const raw = await this.transport.request({
      missionId: input.state.missionId,
      operationId: `gap-${safeSegment(input.gap.id)}-${input.state.revision}`,
      instruction: [
        "Diagnose the supplied open gap from Mission evidence and choose one intervention.",
        "Allowed interventions: retry, revise_work, replace_capability, replan_local, revise_strategy.",
        "When the gap may involve capability mismatch or absence, use hostCapabilityGraph semantics and constraints rather than capability names.",
        "Return JSON with gapId, rootCause, intervention, confidence (0..1).",
        "Do not mark the gap resolved; only independent verifier evidence can resolve it."
      ].join(" "),
      input: {
        mission: plannerContext(context, input.state),
        hostCapabilityGraph: hostCapabilityGraph ? plannerCapabilityGraph(hostCapabilityGraph) : undefined,
        gap: input.gap
      }
    });
    const object = objectValue(raw, "gap diagnosis");
    const gapId = nonEmptyString(object.gapId, "gap diagnosis.gapId");
    if (gapId !== input.gap.id) throw new Error(`Gap diagnosis returned wrong gap id: ${gapId}`);
    const intervention = nonEmptyString(object.intervention, "gap diagnosis.intervention") as GapDiagnosis["intervention"];
    if (!GAP_INTERVENTIONS.has(intervention)) throw new Error(`Unsupported gap intervention: ${intervention}`);
    return {
      gapId,
      rootCause: nonEmptyString(object.rootCause, "gap diagnosis.rootCause"),
      intervention,
      confidence: probability(object.confidence, "gap diagnosis.confidence")
    };
  }

  async challengeCompletion(input: { state: MissionState }): Promise<CompletionChallenge> {
    const context = await this.context(input.state.missionId);
    const raw = await this.transport.request({
      missionId: input.state.missionId,
      operationId: `completion-${input.state.revision}`,
      instruction: [
        "Act as an adversarial independent completion challenger.",
        "The Mission may complete only when the user goal is supported by final artifacts and there is no remaining material objection.",
        "Do not treat producer claims or work-completed events as proof by themselves.",
        "Return JSON with blockingObjection:boolean, objections:[{description, requirementRefs[], artifactRefs[], severity:blocking|non_blocking}], confidence:0..1.",
        "If evidence is insufficient, raise a blocking objection describing the missing evidence."
      ].join(" "),
      input: {
        mission: plannerContext(context, input.state),
        finalArtifactRefs: input.state.finalArtifactRefs
      }
    });
    const object = objectValue(raw, "completion challenge");
    const objections = arrayValue(object.objections, "completion challenge.objections").map((value, index) => {
      const objection = objectValue(value, `completion challenge.objections[${index}]`);
      const severity = nonEmptyString(objection.severity, `completion challenge.objections[${index}].severity`) as "blocking" | "non_blocking";
      if (severity !== "blocking" && severity !== "non_blocking") {
        throw new Error(`Unsupported completion objection severity: ${severity}`);
      }
      return {
        description: nonEmptyString(objection.description, `completion challenge.objections[${index}].description`),
        requirementRefs: stringArray(objection.requirementRefs ?? [], `completion challenge.objections[${index}].requirementRefs`),
        artifactRefs: stringArray(objection.artifactRefs ?? [], `completion challenge.objections[${index}].artifactRefs`),
        severity
      };
    });
    const blockingObjection = booleanValue(object.blockingObjection, "completion challenge.blockingObjection");
    if (!blockingObjection && objections.some(objection => objection.severity === "blocking")) {
      throw new Error("Completion challenge contains blocking objections but blockingObjection=false");
    }
    return {
      blockingObjection,
      objections,
      confidence: probability(object.confidence, "completion challenge.confidence")
    };
  }

  private async context(missionId: string): Promise<DurablePlannerContext> {
    if (this.reader) {
      const [journal, strategy] = await Promise.all([
        this.reader.journal(missionId),
        this.reader.latestStrategy(missionId)
      ]);
      return {
        missionId,
        userGoal: journal.userGoal,
        ...(strategy ? { strategy } : {}),
        capabilityNeeds: [...journal.capabilityNeeds.values()],
        capabilities: [...journal.capabilities.values()],
        workItems: [...journal.workItems.values()],
        artifacts: [...journal.artifacts.values()],
        openGaps: [...journal.gaps.values()].filter(gap => gap.status === "open" || gap.status === "working" || gap.status === "blocked")
      };
    }

    const events = await this.events.list(missionId);
    const journal = projectMissionJournal(missionId, events);
    let strategy: StrategyProposal | undefined;
    for (const event of events) {
      if (event.type !== "strategy.created" && event.type !== "strategy.revised") continue;
      const payload = event.payload as Partial<StrategyProposal>;
      if (typeof payload.framing !== "string" || typeof payload.approach !== "string" ||
          !Array.isArray(payload.workstreams) || typeof payload.revision !== "number") continue;
      strategy = {
        framing: payload.framing,
        approach: payload.approach,
        workstreams: payload.workstreams.map((workstream, index) => {
          const item = objectValue(workstream, `strategy event workstreams[${index}]`);
          return {
            id: nonEmptyString(item.id, `strategy event workstreams[${index}].id`),
            objective: nonEmptyString(item.objective, `strategy event workstreams[${index}].objective`)
          };
        }),
        revision: payload.revision
      };
    }
    return {
      missionId,
      userGoal: journal.userGoal,
      ...(strategy ? { strategy } : {}),
      capabilityNeeds: [...journal.capabilityNeeds.values()],
      capabilities: [...journal.capabilities.values()],
      workItems: [...journal.workItems.values()],
      artifacts: [...journal.artifacts.values()],
      openGaps: [...journal.gaps.values()].filter(gap => gap.status === "open" || gap.status === "working" || gap.status === "blocked")
    };
  }

  private async capabilityGraph(context: DurablePlannerContext): Promise<HostCapabilityGraph | undefined> {
    if (!this.host) return undefined;
    const snapshot = await this.host.snapshotEnvironment();
    const effective = new Map(snapshot.capabilities.map(capability => [capability.id, capability]));
    for (const capability of context.capabilities) {
      if (!capability.available) continue;
      effective.set(capability.id, capability);
    }
    return buildHostCapabilityGraph({
      revision: snapshot.revision,
      host: snapshot.host,
      capabilities: [...effective.values()],
      shellAvailable: snapshot.shellAvailable,
      filesystemAvailable: snapshot.filesystemAvailable,
      browserAvailable: snapshot.browserAvailable
    });
  }

  private normalizeCapabilityNeed(value: unknown, missionId: string, path: string): CapabilityNeed {
    const object = objectValue(value, path);
    const purpose = nonEmptyString(object.purpose, `${path}.purpose`) as CapabilityNeed["purpose"];
    if (!NEED_PURPOSES.has(purpose)) throw new Error(`Unsupported capability need purpose at ${path}: ${purpose}`);
    const urgency = nonEmptyString(object.urgency, `${path}.urgency`) as CapabilityNeed["urgency"];
    if (!NEED_URGENCY.has(urgency)) throw new Error(`Unsupported capability need urgency at ${path}: ${urgency}`);
    const maxRisk = nonEmptyString(object.maxRisk, `${path}.maxRisk`) as RiskLevel;
    if (!RISK_LEVELS.has(maxRisk)) throw new Error(`Unsupported capability maxRisk at ${path}: ${maxRisk}`);
    const requiredFunctions = stringArray(object.requiredFunctions, `${path}.requiredFunctions`);
    if (requiredFunctions.length === 0) throw new Error(`Capability need requires at least one function at ${path}`);
    const policy = object.policy === undefined ? undefined : normalizeCapabilityNeedPolicy(object.policy, `${path}.policy`);
    return {
      id: optionalNonEmptyString(object.id) ?? `capability-need:${randomUUID()}`,
      missionId,
      objective: nonEmptyString(object.objective, `${path}.objective`),
      requiredFunctions,
      desiredInputs: stringArray(object.desiredInputs ?? [], `${path}.desiredInputs`),
      desiredOutputs: stringArray(object.desiredOutputs ?? [], `${path}.desiredOutputs`),
      purpose,
      urgency,
      acquisitionAllowed: booleanValue(object.acquisitionAllowed, `${path}.acquisitionAllowed`),
      maxRisk,
      ...(policy ? { policy } : {}),
      requirementRefs: stringArray(object.requirementRefs ?? [], `${path}.requirementRefs`),
      gapRefs: stringArray(object.gapRefs ?? [], `${path}.gapRefs`)
    };
  }

  private normalizeWorkItem(input: {
    value: unknown;
    path: string;
    missionId: string;
    graphRevision: number;
    now: string;
    createdBy: WorkItem["createdBy"];
    knownNeedIds: Set<string>;
    knownGapIds: Set<string>;
    knownArtifactRefs: Set<string>;
  }): WorkItem {
    const object = objectValue(input.value, input.path);
    const purpose = nonEmptyString(object.purpose, `${input.path}.purpose`) as WorkPurpose;
    if (!WORK_PURPOSES.has(purpose)) throw new Error(`Unsupported work purpose at ${input.path}: ${purpose}`);
    const gapRefs = stringArray(object.gapRefs ?? [], `${input.path}.gapRefs`);
    for (const ref of gapRefs) if (!input.knownGapIds.has(ref)) throw new Error(`Unknown/open gap ref ${ref} at ${input.path}`);
    const inputArtifactRefs = stringArray(object.inputArtifactRefs ?? [], `${input.path}.inputArtifactRefs`);
    for (const ref of inputArtifactRefs) if (!input.knownArtifactRefs.has(ref)) throw new Error(`Unknown artifact ref ${ref} at ${input.path}`);
    const capabilityNeedRefs = stringArray(object.capabilityNeedRefs ?? [], `${input.path}.capabilityNeedRefs`);
    for (const ref of capabilityNeedRefs) if (!input.knownNeedIds.has(ref)) throw new Error(`Unknown capability need ref ${ref} at ${input.path}`);
    const assignedExecutorId = optionalNonEmptyString(object.assignedExecutorId) ?? this.defaultExecutorId;
    if (!assignedExecutorId && this.knownExecutorIds.size > 1) {
      throw new Error(`Planner work ${input.path} omitted assignedExecutorId with multiple routes available`);
    }
    if (assignedExecutorId && !this.knownExecutorIds.has(assignedExecutorId)) {
      throw new Error(`Planner selected unknown executor ${assignedExecutorId} at ${input.path}`);
    }
    const requirementRefs = stringArray(object.requirementRefs ?? [], `${input.path}.requirementRefs`);
    if (purpose !== "exploration" && requirementRefs.length === 0 && gapRefs.length === 0 && inputArtifactRefs.length === 0 && capabilityNeedRefs.length === 0) {
      throw new Error(`Planner produced orphan work at ${input.path}`);
    }
    return {
      id: optionalNonEmptyString(object.id) ?? `work:${randomUUID()}`,
      missionId: input.missionId,
      ...(optionalNonEmptyString(object.workstreamId) ? { workstreamId: optionalNonEmptyString(object.workstreamId) } : {}),
      ...(optionalNonEmptyString(object.parentWorkItemId) ? { parentWorkItemId: optionalNonEmptyString(object.parentWorkItemId) } : {}),
      purpose,
      objective: nonEmptyString(object.objective, `${input.path}.objective`),
      status: "proposed",
      requirementRefs,
      gapRefs,
      inputArtifactRefs,
      expectedOutputs: normalizeExpectedOutputs(object.expectedOutputs ?? [], `${input.path}.expectedOutputs`),
      localAcceptanceCriteria: normalizeAcceptance(object.localAcceptanceCriteria ?? [], `${input.path}.localAcceptanceCriteria`),
      capabilityNeedRefs,
      ...(assignedExecutorId ? { assignedExecutorId } : {}),
      priority: finiteNumber(object.priority ?? 0, `${input.path}.priority`),
      graphRevision: input.graphRevision,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now
    };
  }
}

function plannerContext(context: DurablePlannerContext, state: MissionState) {
  return {
    missionId: context.missionId,
    userGoal: context.userGoal,
    strategy: context.strategy,
    capabilityNeeds: context.capabilityNeeds,
    state: compactState(state),
    workItems: context.workItems,
    artifacts: context.artifacts,
    openGaps: context.openGaps
  };
}

function plannerCapabilityGraph(graph: HostCapabilityGraph) {
  return {
    revision: graph.revision,
    host: graph.host,
    nodes: graph.nodes.map(node => {
      if (node.kind !== "capability") return node;
      const capability = node.capability;
      return {
        id: node.id,
        kind: node.kind,
        capability: {
          id: capability.id,
          kind: capability.kind,
          name: capability.name,
          available: capability.available,
          scope: capability.scope,
          hostNative: capability.hostNative,
          functions: capability.functions,
          accepts: capability.accepts,
          produces: capability.produces,
          permissions: capability.permissions,
          constraints: capability.constraints,
          routing: capability.routing,
          cost: capability.cost,
          native: capability.native,
          provenance: capability.provenance
        }
      };
    }),
    edges: graph.edges
  };
}

function compactState(state: MissionState) {
  return {
    missionId: state.missionId,
    status: state.status,
    revision: state.revision,
    missionSpecRevision: state.missionSpecRevision,
    acceptanceRevision: state.acceptanceRevision,
    strategyRevision: state.strategyRevision,
    graphRevision: state.graphRevision,
    readyWorkItemIds: state.readyWorkItemIds,
    activeWorkItemIds: state.activeWorkItemIds,
    blockedWorkItemIds: state.blockedWorkItemIds,
    verifyingWorkItemIds: state.verifyingWorkItemIds,
    openGapIds: state.openGapIds,
    blockingGapIds: state.blockingGapIds,
    activeExecutionIds: state.activeExecutionIds,
    pendingApprovalIds: state.pendingApprovalIds,
    finalArtifactRefs: state.finalArtifactRefs
  };
}

function normalizeCapabilityNeedPolicy(value: unknown, path: string): CapabilityNeedPolicy {
  const object = objectValue(value, path);
  for (const key of Object.keys(object)) {
    if (!CAPABILITY_NEED_POLICY_KEYS.has(key)) {
      throw new Error(`Unsupported capability need policy field at ${path}: ${key}`);
    }
  }

  const policy: CapabilityNeedPolicy = {};
  if (object.acceptableKinds !== undefined) {
    policy.acceptableKinds = enumStringArray(object.acceptableKinds, `${path}.acceptableKinds`, CAPABILITY_KINDS, "capability kind");
  }
  if (object.requiredExecutionModes !== undefined) {
    policy.requiredExecutionModes = enumStringArray(object.requiredExecutionModes, `${path}.requiredExecutionModes`, CAPABILITY_EXECUTION_MODES, "execution mode");
  }
  if (object.forbiddenPermissions !== undefined) {
    policy.forbiddenPermissions = stringArray(object.forbiddenPermissions, `${path}.forbiddenPermissions`);
  }
  if (object.acceptableProviders !== undefined) {
    policy.acceptableProviders = stringArray(object.acceptableProviders, `${path}.acceptableProviders`);
  }
  if (object.requiredNativeFeatures !== undefined) {
    policy.requiredNativeFeatures = stringArray(object.requiredNativeFeatures, `${path}.requiredNativeFeatures`);
  }
  if (object.acceptableProvenanceSources !== undefined) {
    policy.acceptableProvenanceSources = enumStringArray(
      object.acceptableProvenanceSources,
      `${path}.acceptableProvenanceSources`,
      CAPABILITY_PROVENANCE_SOURCES,
      "provenance source"
    );
  }
  if (object.maxMonetaryClass !== undefined) {
    const monetaryClass = nonEmptyString(object.maxMonetaryClass, `${path}.maxMonetaryClass`) as KnownMonetaryClass;
    if (!CAPABILITY_MONETARY_CLASSES.has(monetaryClass)) {
      throw new Error(`Unsupported capability monetary class at ${path}.maxMonetaryClass: ${monetaryClass}`);
    }
    policy.maxMonetaryClass = monetaryClass;
  }
  return policy;
}

function normalizeExpectedOutputs(value: unknown, path: string): ArtifactExpectation[] {
  return arrayValue(value, path).map((item, index) => {
    const object = objectValue(item, `${path}[${index}]`);
    return {
      logicalName: nonEmptyString(object.logicalName, `${path}[${index}].logicalName`),
      type: nonEmptyString(object.type, `${path}[${index}].type`),
      required: booleanValue(object.required, `${path}[${index}].required`)
    };
  });
}

function normalizeAcceptance(value: unknown, path: string): LocalAcceptanceCriterion[] {
  return arrayValue(value, path).map((item, index) => {
    const object = objectValue(item, `${path}[${index}]`);
    const priority = nonEmptyString(object.priority, `${path}[${index}].priority`);
    if (priority !== "critical" && priority !== "required" && priority !== "preferred") {
      throw new Error(`Unsupported acceptance priority at ${path}[${index}]: ${priority}`);
    }
    return {
      id: optionalNonEmptyString(object.id) ?? `criterion:${randomUUID()}`,
      description: nonEmptyString(object.description, `${path}[${index}].description`),
      priority
    };
  });
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected object at ${path}`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected array at ${path}`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  return arrayValue(value, path).map((item, index) => nonEmptyString(item, `${path}[${index}]`));
}

function enumStringArray<T extends string>(
  value: unknown,
  path: string,
  allowed: ReadonlySet<T>,
  label: string
): T[] {
  return stringArray(value, path).map(item => {
    if (!allowed.has(item as T)) throw new Error(`Unsupported ${label} at ${path}: ${item}`);
    return item as T;
  });
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string at ${path}`);
  return value.trim();
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Expected boolean at ${path}`);
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Expected integer at ${path}`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected finite number at ${path}`);
  return value;
}

function probability(value: unknown, path: string): number {
  const number = finiteNumber(value, path);
  if (number < 0 || number > 1) throw new Error(`Expected probability 0..1 at ${path}`);
  return number;
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Planner returned duplicate ${label}`);
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "gap";
}
