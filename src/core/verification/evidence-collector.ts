import type { Artifact } from "../domain/artifact.ts";
import type { Evidence, VerificationEvidenceKind } from "../domain/verification.ts";
import type { VerificationProfile } from "./verification-profile.ts";

export interface VerificationEvidenceDraft {
  type: Evidence["type"];
  kind: VerificationEvidenceKind;
  claim: string;
  result: Evidence["result"];
  sourceRef?: string;
  details?: Record<string, unknown>;
  /**
   * Bounded inspection material supplied only to the verifier request. It is
   * deliberately excluded from the durable Evidence entity so large artifact
   * bodies do not become an accidental audit-log replica.
   */
  inspectionPayload?: unknown;
}

export interface VerificationEvidenceCollectorInput {
  artifact: Artifact;
  profile: VerificationProfile;
  maxInspectionBytes: number;
}

export interface VerificationEvidenceCollector {
  readonly id: string;
  readonly kinds: readonly VerificationEvidenceKind[];
  supports(input: VerificationEvidenceCollectorInput): boolean;
  collect(input: VerificationEvidenceCollectorInput): Promise<VerificationEvidenceDraft[]> | VerificationEvidenceDraft[];
}

export interface VerificationEvidenceCollectorFailure {
  collectorId: string;
  kinds: VerificationEvidenceKind[];
  reason: string;
}

export interface VerificationEvidenceCollectedDraft {
  collectorId: string;
  draft: VerificationEvidenceDraft;
}

export interface VerificationEvidenceCollection {
  collected: VerificationEvidenceCollectedDraft[];
  failures: VerificationEvidenceCollectorFailure[];
  attemptedCollectorIds: string[];
}

const EVIDENCE_TYPES = new Set<Evidence["type"]>([
  "test-result",
  "render-inspection",
  "source",
  "runtime-check",
  "human-approval",
  "automated-review",
  "file-validation"
]);
const EVIDENCE_RESULTS = new Set<Evidence["result"]>(["supports", "contradicts", "inconclusive"]);

/**
 * Collectors are independent evidence adapters. One broken optional adapter must
 * not cause another collector's valid evidence to disappear; its declared kinds
 * are instead reported unavailable so affected profile checks fail closed.
 */
export class VerificationEvidenceCollectorRegistry {
  private readonly collectors: VerificationEvidenceCollector[];

  constructor(collectors: VerificationEvidenceCollector[]) {
    const ids = new Set<string>();
    this.collectors = collectors.map(collector => {
      if (!collector.id.trim()) throw new Error("Verification evidence collector id must be non-empty");
      if (ids.has(collector.id)) throw new Error(`Duplicate verification evidence collector id: ${collector.id}`);
      ids.add(collector.id);
      if (collector.kinds.length === 0) throw new Error(`Verification evidence collector ${collector.id} declares no evidence kinds`);
      return collector;
    });
  }

  list(): VerificationEvidenceCollector[] {
    return [...this.collectors];
  }

  async collect(input: VerificationEvidenceCollectorInput): Promise<VerificationEvidenceCollection> {
    const applicable: VerificationEvidenceCollector[] = [];
    const failures: VerificationEvidenceCollectorFailure[] = [];
    const attemptedCollectorIds: string[] = [];

    for (const collector of this.collectors) {
      try {
        if (!collector.supports(input)) continue;
        applicable.push(collector);
        attemptedCollectorIds.push(collector.id);
      } catch (error) {
        attemptedCollectorIds.push(collector.id);
        failures.push(failureFor(collector, `supports() failed: ${errorMessage(error)}`));
      }
    }

    // Start collection from a resolved promise so synchronous throws are turned
    // into rejected promises and isolated by allSettled just like async failures.
    const settled = await Promise.allSettled(
      applicable.map(collector => Promise.resolve().then(() => collector.collect(input)))
    );
    const collected: VerificationEvidenceCollectedDraft[] = [];

    for (let index = 0; index < applicable.length; index += 1) {
      const collector = applicable[index]!;
      const result = settled[index]!;
      if (result.status === "rejected") {
        failures.push(failureFor(collector, errorMessage(result.reason)));
        continue;
      }
      if (!Array.isArray(result.value)) {
        failures.push(failureFor(collector, "Collector returned a non-array evidence result"));
        continue;
      }
      for (let draftIndex = 0; draftIndex < result.value.length; draftIndex += 1) {
        try {
          const draft = normalizeDraft(result.value[draftIndex], collector);
          collected.push({ collectorId: collector.id, draft });
        } catch (error) {
          failures.push(failureFor(collector, `draft[${draftIndex}] rejected: ${errorMessage(error)}`));
        }
      }
    }

    return {
      collected,
      failures,
      attemptedCollectorIds
    };
  }
}

function normalizeDraft(value: unknown, collector: VerificationEvidenceCollector): VerificationEvidenceDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("evidence draft must be an object");
  }
  const draft = value as Record<string, unknown>;
  if (typeof draft.kind !== "string" || !collector.kinds.includes(draft.kind as VerificationEvidenceKind)) {
    throw new Error(`Collector emitted undeclared evidence kind ${String(draft.kind)}`);
  }
  if (typeof draft.type !== "string" || !EVIDENCE_TYPES.has(draft.type as Evidence["type"])) {
    throw new Error(`unsupported evidence type ${String(draft.type)}`);
  }
  if (typeof draft.claim !== "string" || !draft.claim.trim()) {
    throw new Error("evidence claim must be a non-empty string");
  }
  if (typeof draft.result !== "string" || !EVIDENCE_RESULTS.has(draft.result as Evidence["result"])) {
    throw new Error(`unsupported evidence result ${String(draft.result)}`);
  }
  if (draft.sourceRef !== undefined && (typeof draft.sourceRef !== "string" || !draft.sourceRef.trim())) {
    throw new Error("evidence sourceRef must be a non-empty string when supplied");
  }
  if (draft.details !== undefined && (!draft.details || typeof draft.details !== "object" || Array.isArray(draft.details))) {
    throw new Error("evidence details must be an object when supplied");
  }

  return {
    type: draft.type as Evidence["type"],
    kind: draft.kind as VerificationEvidenceKind,
    claim: draft.claim.trim(),
    result: draft.result as Evidence["result"],
    ...(typeof draft.sourceRef === "string" ? { sourceRef: draft.sourceRef.trim() } : {}),
    ...(draft.details ? { details: structuredClone(draft.details as Record<string, unknown>) } : {}),
    ...(draft.inspectionPayload === undefined ? {} : { inspectionPayload: structuredClone(draft.inspectionPayload) })
  };
}

function failureFor(collector: VerificationEvidenceCollector, reason: string): VerificationEvidenceCollectorFailure {
  return {
    collectorId: collector.id,
    kinds: [...collector.kinds],
    reason
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
