import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Artifact } from "../core/domain/artifact.ts";
import type { GapAssessment, VerificationCheckResult, VerificationResult } from "../core/domain/verification.ts";
import type { EventStore } from "../core/events/event-store.ts";
import { projectMissionJournal } from "../core/mission/journal-view.ts";
import type { MissionReadModelReader } from "../core/mission/mission-reader.ts";
import type { VerificationContext, Verifier } from "../core/verification/verifier.ts";
import type { HostJsonTransport } from "./host-agent-json-transport.ts";

export interface HostArtifactVerifierOptions {
  transport: HostJsonTransport;
  events: EventStore;
  reader?: MissionReadModelReader;
  maxInlineBytes?: number;
}

const OVERALL = new Set<VerificationResult["overall"]>(["pass", "pass_with_warnings", "fail", "inconclusive"]);
const CHECK_STATUS = new Set<VerificationCheckResult["status"]>(["pass", "fail", "warning", "inconclusive"]);
const GAP_STATUS = new Set<GapAssessment["status"]>(["resolved", "still_open", "inconclusive"]);

export class HostArtifactVerifier implements Verifier {
  readonly id = "host-artifact-verifier";
  private readonly transport: HostJsonTransport;
  private readonly events: EventStore;
  private readonly reader?: MissionReadModelReader;
  private readonly maxInlineBytes: number;

  constructor(options: HostArtifactVerifierOptions) {
    this.transport = options.transport;
    this.events = options.events;
    this.reader = options.reader;
    this.maxInlineBytes = Math.max(1_024, options.maxInlineBytes ?? 64 * 1_024);
  }

  async verify(artifact: Artifact, context?: VerificationContext): Promise<VerificationResult> {
    const structural = structuralChecks(artifact);
    if (!structural.passed) {
      return resultBase(artifact, this.id, {
        level: "structural",
        overall: "fail",
        checkResults: structural.checkResults,
        evidenceRefs: structural.evidenceRefs,
        gapAssessments: []
      });
    }
    if (!context) {
      return resultBase(artifact, this.id, {
        level: "quality",
        overall: "inconclusive",
        checkResults: [
          ...structural.checkResults,
          {
            id: "mission-context",
            status: "inconclusive",
            detail: "Mission-level verifier context was not supplied.",
            evidenceRefs: []
          }
        ],
        evidenceRefs: structural.evidenceRefs,
        gapAssessments: []
      });
    }

    const journal = this.reader
      ? await this.reader.journal(artifact.missionId)
      : projectMissionJournal(artifact.missionId, await this.events.list(artifact.missionId));
    const inline = inlineArtifact(artifact, this.maxInlineBytes);
    const raw = await this.transport.request({
      missionId: artifact.missionId,
      operationId: `verify-${safeSegment(artifact.id)}-${artifact.version}-${context.state.revision}`,
      instruction: [
        "Independently verify the candidate artifact against the Mission goal, the WorkItem objective/local acceptance criteria, and the supplied open gaps.",
        "Do not trust producer completion claims. Use the artifact content/evidence supplied here; if more evidence is needed, return inconclusive or fail rather than guessing.",
        "Return JSON with overall:pass|pass_with_warnings|fail|inconclusive, checkResults:[{id,status:pass|fail|warning|inconclusive,detail?,evidenceRefs[]}], evidenceRefs:[], gapAssessments:[{gapId,status:resolved|still_open|inconclusive,evidenceRefs[],confidence,detail?}].",
        "Assess only gaps explicitly supplied in input.gaps. A resolved assessment must cite concrete evidenceRefs.",
        "A pass result must not contain failed or inconclusive checks."
      ].join(" "),
      input: {
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
        }
      }
    });

    const reviewed = normalizeReview(raw, new Set(context.gaps.map(gap => gap.id)));
    if ((reviewed.overall === "pass" || reviewed.overall === "pass_with_warnings") &&
        reviewed.checkResults.some(check => check.status === "fail" || check.status === "inconclusive")) {
      throw new Error("Host verifier returned a passing overall status with failed/inconclusive checks");
    }

    return resultBase(artifact, this.id, {
      level: "mission",
      overall: reviewed.overall,
      checkResults: [...structural.checkResults, ...reviewed.checkResults],
      evidenceRefs: unique([...structural.evidenceRefs, ...reviewed.evidenceRefs]),
      gapAssessments: reviewed.gapAssessments
    });
  }
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

function normalizeReview(raw: unknown, allowedGapIds: Set<string>): {
  overall: VerificationResult["overall"];
  checkResults: VerificationCheckResult[];
  evidenceRefs: string[];
  gapAssessments: GapAssessment[];
} {
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

function resultBase(
  artifact: Artifact,
  verifierId: string,
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
    verificationProfileId: input.level === "mission" ? "host-mission-review-v1" : "deterministic-file-integrity-v1",
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
