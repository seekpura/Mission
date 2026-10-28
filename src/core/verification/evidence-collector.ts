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
    const applicable = this.collectors.filter(collector => collector.supports(input));
    // Start collection from a resolved promise so synchronous throws are turned
    // into rejected promises and isolated by allSettled just like async failures.
    const settled = await Promise.allSettled(
      applicable.map(collector => Promise.resolve().then(() => collector.collect(input)))
    );
    const collected: VerificationEvidenceCollectedDraft[] = [];
    const failures: VerificationEvidenceCollectorFailure[] = [];

    for (let index = 0; index < applicable.length; index += 1) {
      const collector = applicable[index]!;
      const result = settled[index]!;
      if (result.status === "rejected") {
        failures.push({
          collectorId: collector.id,
          kinds: [...collector.kinds],
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
        continue;
      }
      for (const draft of result.value) {
        if (!collector.kinds.includes(draft.kind)) {
          failures.push({
            collectorId: collector.id,
            kinds: [...collector.kinds],
            reason: `Collector emitted undeclared evidence kind ${draft.kind}`
          });
          continue;
        }
        collected.push({ collectorId: collector.id, draft: cloneDraft(draft) });
      }
    }

    return {
      collected,
      failures,
      attemptedCollectorIds: applicable.map(collector => collector.id)
    };
  }
}

function cloneDraft(draft: VerificationEvidenceDraft): VerificationEvidenceDraft {
  return {
    ...draft,
    ...(draft.details ? { details: structuredClone(draft.details) } : {}),
    ...(draft.inspectionPayload === undefined ? {} : { inspectionPayload: structuredClone(draft.inspectionPayload) })
  };
}
