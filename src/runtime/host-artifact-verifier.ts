import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Artifact } from "../core/domain/artifact.ts";
import type {
  Evidence,
  GapAssessment,
  VerificationCheckResult,
  VerificationEvidenceKind,
  VerificationResult
} from "../core/domain/verification.ts";
import type { EventStore } from "../core/events/event-store.ts";
import { projectMissionJournal } from "../core/mission/journal-view.ts";
import type { MissionReadModelReader } from "../core/mission/mission-reader.ts";
import type {
  VerificationEvidenceCollection,
  VerificationEvidenceCollectorRegistry
} from "../core/verification/evidence-collector.ts";
import {
  createDefaultVerificationProfileRegistry,
  type VerificationEvidencePolicy,
  type VerificationProfile,
  type VerificationProfileRegistry
} from "../core/verification/verification-profile.ts";
import type { VerificationContext, Verifier } from "../core/verification/verifier.ts";
import type { HostJsonTransport } from "./host-agent-json-transport.ts";
import { createDefaultVerificationEvidenceCollectorRegistry } from "./verification-evidence-collectors.ts";

export interface HostArtifactVerifierOptions {
  transport: HostJsonTransport;
  events: EventStore;
  reader?: MissionReadModelReader;
  profiles?: VerificationProfileRegistry;
  evidenceCollectors?: VerificationEvidenceCollectorRegistry;
  maxInlineBytes?: number;
}

const OVERALL = new Set<VerificationResult["overall"]>(["pass", "pass_with_warnings", "fail", "inconclusive"]);
const CHECK_STATUS = new Set<VerificationCheckResult["status"]>(["pass", "fail", "warning", "inconclusive"]);
const GAP_STATUS = new Set<GapAssessment["status"]>(["resolved", "still_open", "inconclusive"]);

interface NormalizedReview {
  overall: VerificationResult["overall"];
  checkResults: VerificationCheckResult[];
  evidenceRefs: string[];
  gapAssessments: GapAssessment[];
}

interface RegisteredEvidence {
  evidence: Evidence;
  inspectionPayload?: unknown;
}

export class HostArtifactVerifier implements Verifier {
  readonly id = "host-artifact-verifier";
  private readonly transport: HostJsonTransport;
  private readonly events: EventStore;
  private readonly reader?: MissionReadModelReader;
  private readonly profiles: VerificationProfileRegistry;
  private readonly evidenceCollectors: VerificationEvidenceCollectorRegistry;
  private readonly maxInlineBytes: number;

  constructor(options: HostArtifactVerifierOptions) {
    this.transport = options.transport;
    this.events = options.events;
    this.reader = options.reader;
    this.profiles = options.profiles ?? createDefaultVerificationProfileRegistry();
    this.evidenceCollectors = options.evidenceCollectors ?? createDefaultVerificationEvidenceCollectorRegistry();
    this.maxInlineBytes = Math.max(1_024, options.maxInlineBytes ?? 64 * 1_024);
  }

  async verify(artifact: Artifact, context?: VerificationContext): Promise<VerificationResult> {
    const selection = this.profiles.select(artifact);
    const profile = selection.profile;
    const structural = structuralChecks(artifact);
    if (!structural.passed) {
      return resultBase(artifact, this.id, "deterministic-file-integrity-v1", {
        level: "structural",
        overall: "fail",
        checkResults: structural.checkResults,
        evidenceRefs: structural.evidenceRefs,
        gapAssessments: []
      });
    }
    if (!context) {
      return resultBase(artifact, this.id, profile.id, {
        level: "quality",
        overall: "inconclusive",
        checkResults: [
          ...structural.checkResults,
          {
            id: "mission-context",
            status: "inconclusive",
            detail: `Mission-level verifier context was not supplied for profile ${profile.id}.`,
            evidenceRefs: []
          },
          ...profile.checks.map(check => ({
            id: check.id,
            status: "inconclusive" as const,
            detail: "Required profile check could not run without Mission-level context.",
            evidenceRefs: []
          }))
        ],
        evidenceRefs: structural.evidenceRefs,
        gapAssessments: []
      });
    }

    const journal = this.reader
      ? await this.reader.journal(artifact.missionId)
      : projectMissionJournal(artifact.missionId, await this.events.list(artifact.missionId));
    const profileInlineLimit = Math.min(this.maxInlineBytes, profile.maxInlineBytes ?? this.maxInlineBytes);
    const inline = inlineArtifact(artifact, profileInlineLimit);
    const collection = await this.evidenceCollectors.collect({
      artifact,
      profile,
      maxInspectionBytes: profileInlineLimit
    });
    const registered = await this.registerEvidence(artifact, profile, context.state.revision, collection);
    const evidenceById = new Map(registered.map(item => [item.evidence.id, item.evidence]));
    const availability = profile.checks.map(check => checkEvidenceAvailability(check.evidencePolicy, evidenceById));

    const raw = await this.transport.request({
      missionId: artifact.missionId,
      operationId: `verify-${safeSegment(profile.kind)}-${safeSegment(artifact.id)}-${artifact.version}-${context.state.revision}`,
      instruction: buildProfileInstruction(profile),
      input: {
        verificationProfile: {
          id: profile.id,
          kind: profile.kind,
          title: profile.title,
          selectionReason: selection.reason,
          checks: profile.checks,
          evidenceRequirements: profile.evidenceRequirements
        },
        userGoal: journal.userGoal,
        artifact: {
          id: artifact.id,
          logicalName: artifact.logicalName,
          type: artifact.type,
          version: artifact.version,
          uri: artifact.uri,
          contentHash: artifact.contentHash,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sourceArtifactRefs: artifact.sourceArtifactRefs,
          ...(inline ? { inlineContent: inline } : {})
        },
        workItem: {
          id: context.workItem.id,
          purpose: context.workItem.purpose,
          objective: context.workItem.objective,
          requirementRefs: context.workItem.requirementRefs,
          gapRefs: context.workItem.gapRefs,
          expectedOutputs: context.workItem.expectedOutputs,
          localAcceptanceCriteria: context.workItem.localAcceptanceCriteria
        },
        gaps: context.gaps,
        missionState: {
          revision: context.state.revision,
          finalArtifactRefs: context.state.finalArtifactRefs,
          blockingGapIds: context.state.blockingGapIds
        },
        deterministicEvidence: {
          checks: structural.checkResults,
          evidenceRefs: structural.evidenceRefs
        },
        runtimeEvidence: registered.map(item => ({
          ...item.evidence,
          ...(item.inspectionPayload === undefined ? {} : { inspectionPayload: item.inspectionPayload })
        })),
        evidenceAvailability: profile.checks.map((check, index) => ({
          checkId: check.id,
          policy: check.evidencePolicy,
          ...availability[index]
        })),
        collectorFailures: collection.failures
      }
    });

    const normalized = normalizeReview(raw, new Set(context.gaps.map(gap => gap.id)));
    validateRuntimeEvidenceReferences(normalized, evidenceById);
    const covered = enforceProfileCoverage(normalized, profile);
    const reviewed = enforceProfileEvidence(covered, profile, evidenceById);
    if ((reviewed.overall === "pass" || reviewed.overall === "pass_with_warnings") &&
        reviewed.checkResults.some(check => check.status === "fail" || check.status === "inconclusive")) {
      throw new Error("Host verifier returned a passing overall status with failed/inconclusive checks");
    }

    return resultBase(artifact, this.id, profile.id, {
      level: "mission",
      overall: reviewed.overall,
      checkResults: [...structural.checkResults, ...reviewed.checkResults],
      evidenceRefs: unique([
        ...structural.evidenceRefs,
        ...registered.map(item => item.evidence.id),
        ...reviewed.evidenceRefs
      ]),
      gapAssessments: reviewed.gapAssessments
    });
  }

  private async registerEvidence(
    artifact: Artifact,
    profile: VerificationProfile,
    missionRevision: number,
    collection: VerificationEvidenceCollection
  ): Promise<RegisteredEvidence[]> {
    const registered: RegisteredEvidence[] = [];
    const subjectRef = `${artifact.id}@${artifact.version}`;
    for (let index = 0; index < collection.collected.length; index += 1) {
      const item = collection.collected[index]!;
      const draft = item.draft;
      const token = createHash("sha256").update(stableJson({
        subjectRef,
        profileId: profile.id,
        missionRevision,
        collectorId: item.collectorId,
        kind: draft.kind,
        type: draft.type,
        claim: draft.claim,
        result: draft.result,
        sourceRef: draft.sourceRef ?? null,
        details: draft.details ?? null,
        index
      })).digest("hex");
      const evidence: Evidence = {
        id: `evidence:${token.slice(0, 40)}`,
        missionId: artifact.missionId,
        subjectRef,
        type: draft.type,
        kind: draft.kind,
        claim: draft.claim,
        result: draft.result,
        collectorId: item.collectorId,
        ...(draft.sourceRef ? { sourceRef: draft.sourceRef } : {}),
        producedBy: this.id,
        ...(draft.details ? { details: structuredClone(draft.details) } : {}),
        createdAt: new Date().toISOString()
      };
      const committed = await appendEvidence(this.events, evidence, `evidence-collected:${token}`);
      registered.push({
        evidence: committed,
        ...(draft.inspectionPayload === undefined ? {} : { inspectionPayload: structuredClone(draft.inspectionPayload) })
      });
    }
    return registered;
  }
}

function buildProfileInstruction(profile: VerificationProfile): string {
  const checks = profile.checks
    .map(check => {
      const policy = evidencePolicyDescription(check.evidencePolicy);
      return `${check.id}: ${check.objective} Evidence expectation: ${check.evidenceExpectation}. Runtime evidence policy: ${policy}.`;
    })
    .join(" ");
  const evidence = profile.evidenceRequirements.join(" ");
  return [
    "Independently verify the candidate artifact against the Mission goal, the WorkItem objective/local acceptance criteria, and the supplied open gaps.",
    `Use verification profile ${profile.id} (${profile.title}).`,
    ...profile.instructions,
    `Required profile checks: ${checks}`,
    `Profile evidence requirements: ${evidence}`,
    "runtimeEvidence is the authoritative evidence registry for this review. Cite only runtimeEvidence[].id in checkResults/evidenceRefs/gapAssessments; never invent an evidence id and never cite a raw filename, hash, test claim, render claim, browser claim or producer claim as if it were registered Evidence.",
    "deterministicEvidence contains structural file checks for context, but required profile evidence policies are satisfied only by supporting Runtime Evidence of the declared kinds.",
    "Do not trust producer completion claims. Never infer that a render, browser interaction, playback, test, build, source validation or accessibility check occurred unless corresponding Runtime Evidence is supplied.",
    "Every required profile check id must appear exactly once in checkResults. When the required Runtime Evidence kind is unavailable, mark that check inconclusive instead of omitting it or guessing.",
    "Return JSON with overall:pass|pass_with_warnings|fail|inconclusive, checkResults:[{id,status:pass|fail|warning|inconclusive,detail?,evidenceRefs[]}], evidenceRefs:[], gapAssessments:[{gapId,status:resolved|still_open|inconclusive,evidenceRefs[],confidence,detail?}].",
    "Assess only gaps explicitly supplied in input.gaps. A resolved assessment must cite concrete Runtime Evidence refs.",
    "A pass result must not contain failed or inconclusive checks."
  ].join(" ");
}

function structuralChecks(artifact: Artifact): {
  passed: boolean;
  checkResults: VerificationCheckResult[];
  evidenceRefs: string[];
} {
  const exists = existsSync(artifact.uri);
  const isFile = exists && statSync(artifact.uri).isFile();
  const nonEmpty = isFile && statSync(artifact.uri).size > 0;
  let hashMatches = false;
  let actualHash = "";
  if (isFile) {
    actualHash = createHash("sha256").update(readFileSync(artifact.uri)).digest("hex");
    hashMatches = actualHash === normalizeHash(artifact.contentHash);
  }
  const evidenceRefs = [
    ...(exists ? [`file:${artifact.uri}`] : []),
    ...(actualHash ? [`sha256:${actualHash}`] : [])
  ];
  const checkResults: VerificationCheckResult[] = [
    { id: "file-exists", status: exists ? "pass" : "fail", evidenceRefs: exists ? [`file:${artifact.uri}`] : [] },
    { id: "file-regular", status: isFile ? "pass" : "fail", evidenceRefs: isFile ? [`file:${artifact.uri}`] : [] },
    { id: "file-non-empty", status: nonEmpty ? "pass" : "fail", evidenceRefs: nonEmpty ? [`file:${artifact.uri}`] : [] },
    {
      id: "content-hash",
      status: hashMatches ? "pass" : "fail",
      detail: hashMatches ? "Committed artifact hash matches current file bytes." : "Committed artifact hash does not match current file bytes.",
      evidenceRefs: actualHash ? [`sha256:${actualHash}`] : []
    }
  ];
  return { passed: exists && isFile && nonEmpty && hashMatches, checkResults, evidenceRefs };
}

function inlineArtifact(artifact: Artifact, maxInlineBytes: number): string | undefined {
  if (!existsSync(artifact.uri)) return undefined;
  const info = statSync(artifact.uri);
  if (!info.isFile() || info.size > maxInlineBytes) return undefined;
  const bytes = readFileSync(artifact.uri);
  if (bytes.includes(0)) return undefined;
  const text = bytes.toString("utf8");
  const replacementCount = [...text].filter(character => character === "�").length;
  if (replacementCount > Math.max(2, text.length / 200)) return undefined;
  return text;
}

function normalizeReview(raw: unknown, allowedGapIds: Set<string>): NormalizedReview {
  const object = objectValue(raw, "verification review");
  const overall = nonEmptyString(object.overall, "verification review.overall") as VerificationResult["overall"];
  if (!OVERALL.has(overall)) throw new Error(`Unsupported verification overall status: ${overall}`);
  const checkResults = arrayValue(object.checkResults, "verification review.checkResults").map((value, index) => {
    const check = objectValue(value, `verification review.checkResults[${index}]`);
    const status = nonEmptyString(check.status, `verification review.checkResults[${index}].status`) as VerificationCheckResult["status"];
    if (!CHECK_STATUS.has(status)) throw new Error(`Unsupported verification check status: ${status}`);
    return {
      id: nonEmptyString(check.id, `verification review.checkResults[${index}].id`),
      status,
      ...(typeof check.detail === "string" && check.detail.trim() ? { detail: check.detail.trim() } : {}),
      evidenceRefs: stringArray(check.evidenceRefs ?? [], `verification review.checkResults[${index}].evidenceRefs`)
    };
  });
  const gapAssessments = arrayValue(object.gapAssessments ?? [], "verification review.gapAssessments").map((value, index) => {
    const assessment = objectValue(value, `verification review.gapAssessments[${index}]`);
    const gapId = nonEmptyString(assessment.gapId, `verification review.gapAssessments[${index}].gapId`);
    if (!allowedGapIds.has(gapId)) throw new Error(`Host verifier assessed unrelated gap: ${gapId}`);
    const status = nonEmptyString(assessment.status, `verification review.gapAssessments[${index}].status`) as GapAssessment["status"];
    if (!GAP_STATUS.has(status)) throw new Error(`Unsupported gap assessment status: ${status}`);
    const evidenceRefs = stringArray(assessment.evidenceRefs ?? [], `verification review.gapAssessments[${index}].evidenceRefs`);
    if (status === "resolved" && evidenceRefs.length === 0) {
      throw new Error(`Resolved gap assessment requires evidenceRefs: ${gapId}`);
    }
    return {
      gapId,
      status,
      evidenceRefs,
      confidence: probability(assessment.confidence, `verification review.gapAssessments[${index}].confidence`),
      ...(typeof assessment.detail === "string" && assessment.detail.trim() ? { detail: assessment.detail.trim() } : {})
    };
  });
  return {
    overall,
    checkResults,
    evidenceRefs: stringArray(object.evidenceRefs ?? [], "verification review.evidenceRefs"),
    gapAssessments
  };
}

function validateRuntimeEvidenceReferences(review: NormalizedReview, evidenceById: Map<string, Evidence>): void {
  const validate = (refs: string[], owner: string) => {
    const unknown = refs.filter(ref => !evidenceById.has(ref));
    if (unknown.length > 0) {
      throw new Error(`Host verifier referenced unregistered Runtime Evidence in ${owner}: ${unique(unknown).sort().join(", ")}`);
    }
  };
  validate(review.evidenceRefs, "verification review.evidenceRefs");
  for (const check of review.checkResults) validate(check.evidenceRefs, `check ${check.id}`);
  for (const gap of review.gapAssessments) validate(gap.evidenceRefs, `gap ${gap.gapId}`);
}

function enforceProfileCoverage(review: NormalizedReview, profile: VerificationProfile): NormalizedReview {
  const requiredIds = new Set(profile.checks.map(check => check.id));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const check of review.checkResults) {
    if (!requiredIds.has(check.id)) continue;
    if (seen.has(check.id)) duplicates.add(check.id);
    seen.add(check.id);
  }
  if (duplicates.size > 0) {
    throw new Error(`Host verifier duplicated required profile checks: ${[...duplicates].sort().join(", ")}`);
  }

  const missing = profile.checks.filter(check => !seen.has(check.id));
  if (missing.length === 0) return review;
  return {
    ...review,
    overall: review.overall === "fail" ? "fail" : "inconclusive",
    checkResults: [
      ...review.checkResults,
      ...missing.map(check => ({
        id: check.id,
        status: "inconclusive" as const,
        detail: `Verifier omitted required profile check. Expected evidence: ${check.evidenceExpectation}`,
        evidenceRefs: []
      }))
    ]
  };
}

function enforceProfileEvidence(
  review: NormalizedReview,
  profile: VerificationProfile,
  evidenceById: Map<string, Evidence>
): NormalizedReview {
  const profileChecks = new Map(profile.checks.map(check => [check.id, check]));
  let downgraded = false;
  const checkResults = review.checkResults.map(check => {
    const profileCheck = profileChecks.get(check.id);
    if (!profileCheck || (check.status !== "pass" && check.status !== "warning")) return check;
    const availability = checkEvidenceAvailability(profileCheck.evidencePolicy, evidenceById, check.evidenceRefs);
    if (availability.satisfied) return check;
    downgraded = true;
    return {
      ...check,
      status: "inconclusive" as const,
      detail: [
        check.detail,
        `Runtime Evidence policy not satisfied: ${availability.reason}. Expected ${profileCheck.evidenceExpectation}`
      ].filter(Boolean).join(" "),
      evidenceRefs: [...check.evidenceRefs]
    };
  });
  return {
    ...review,
    overall: downgraded && review.overall !== "fail" ? "inconclusive" : review.overall,
    checkResults
  };
}

function checkEvidenceAvailability(
  policy: VerificationEvidencePolicy,
  evidenceById: Map<string, Evidence>,
  refs?: string[]
): {
  satisfied: boolean;
  supportingRefs: string[];
  supportingKinds: VerificationEvidenceKind[];
  missingAllOf: VerificationEvidenceKind[];
  anyOfSatisfied: boolean;
  reason: string;
} {
  const scope = refs ? refs.map(ref => evidenceById.get(ref)).filter((item): item is Evidence => Boolean(item)) : [...evidenceById.values()];
  const supporting = scope.filter(evidence => evidence.result === "supports");
  const kinds = new Set(supporting.map(evidence => evidence.kind));
  const allOf = policy.allOf ?? [];
  const anyOf = policy.anyOf ?? [];
  const missingAllOf = allOf.filter(kind => !kinds.has(kind));
  const anyOfSatisfied = anyOf.length === 0 || anyOf.some(kind => kinds.has(kind));
  const minimum = Math.max(0, policy.minimumSupportingRefs ?? (allOf.length === 0 && anyOf.length === 0 ? 0 : 1));
  const countSatisfied = supporting.length >= minimum;
  const satisfied = missingAllOf.length === 0 && anyOfSatisfied && countSatisfied;
  const reason = satisfied
    ? "required Runtime Evidence is present"
    : [
        missingAllOf.length > 0 ? `missing allOf kinds ${missingAllOf.join(", ")}` : "",
        !anyOfSatisfied ? `none of anyOf kinds present (${anyOf.join(", ")})` : "",
        !countSatisfied ? `only ${supporting.length} supporting refs; minimum ${minimum}` : ""
      ].filter(Boolean).join("; ");
  return {
    satisfied,
    supportingRefs: supporting.map(evidence => evidence.id),
    supportingKinds: [...kinds],
    missingAllOf,
    anyOfSatisfied,
    reason
  };
}

async function appendEvidence(events: EventStore, evidence: Evidence, idempotencyKey: string): Promise<Evidence> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const expected = await events.lastSequence(evidence.missionId);
    try {
      const committed = await events.append({
        id: randomUUID(),
        missionId: evidence.missionId,
        type: "evidence.collected",
        actor: { type: "verifier", id: evidence.producedBy },
        payload: evidence,
        idempotencyKey,
        schemaVersion: 1,
        createdAt: evidence.createdAt
      }, expected);
      return structuredClone(committed.payload as Evidence);
    } catch (error) {
      if (attempt === 4 || !(error instanceof Error) || !error.name.includes("Concurrency")) throw error;
    }
  }
  throw new Error("Unreachable verification evidence append retry state");
}

function evidencePolicyDescription(policy: VerificationEvidencePolicy): string {
  const parts: string[] = [];
  if (policy.allOf?.length) parts.push(`allOf=[${policy.allOf.join(",")}]`);
  if (policy.anyOf?.length) parts.push(`anyOf=[${policy.anyOf.join(",")}]`);
  if (policy.minimumSupportingRefs !== undefined) parts.push(`minimumSupportingRefs=${policy.minimumSupportingRefs}`);
  return parts.join(" ") || "no additional kind constraint";
}

function resultBase(
  artifact: Artifact,
  verifierId: string,
  verificationProfileId: string,
  input: {
    level: VerificationResult["level"];
    overall: VerificationResult["overall"];
    checkResults: VerificationCheckResult[];
    evidenceRefs: string[];
    gapAssessments: GapAssessment[];
  }
): VerificationResult {
  return {
    id: randomUUID(),
    missionId: artifact.missionId,
    artifactRef: `${artifact.id}@${artifact.version}`,
    verificationProfileId,
    verifierId,
    level: input.level,
    overall: input.overall,
    checkResults: input.checkResults,
    findingRefs: [],
    evidenceRefs: input.evidenceRefs,
    gapAssessments: input.gapAssessments,
    createdAt: new Date().toISOString()
  };
}

function normalizeHash(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected object at ${path}`);
  return value as Record<string, unknown>;
}
function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected array at ${path}`);
  return value;
}
function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string at ${path}`);
  return value.trim();
}
function stringArray(value: unknown, path: string): string[] {
  return arrayValue(value, path).map((item, index) => nonEmptyString(item, `${path}[${index}]`));
}
function probability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Expected probability 0..1 at ${path}`);
  }
  return value;
}
function unique(values: string[]): string[] { return [...new Set(values)]; }
function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "artifact";
}
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}
