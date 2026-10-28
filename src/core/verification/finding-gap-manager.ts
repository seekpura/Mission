import type { Finding, Gap } from "../domain/verification.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";
import type { MissionController } from "../mission/controller.ts";
import { GapClusterer, type GapSeed } from "./gap-clusterer.ts";
import { normalizeFinding } from "./finding-normalizer.ts";

export interface RecordFindingOptions extends GapSeed {
  createGap?: boolean;
}

export interface RecordFindingResult {
  finding: Finding;
  gap: Gap | null;
  action: "recorded" | "created_gap" | "updated_gap" | "reopened_gap" | "duplicate";
}

export class FindingGapManager {
  private readonly controller: MissionController;
  private readonly projections: MissionProjectionReader;
  private readonly clusterer: GapClusterer;

  constructor(input: { controller: MissionController; projections: MissionProjectionReader; clusterer?: GapClusterer }) {
    this.controller = input.controller;
    this.projections = input.projections;
    this.clusterer = input.clusterer ?? new GapClusterer();
  }

  async record(finding: Finding, options: RecordFindingOptions = {}): Promise<RecordFindingResult> {
    const normalized = normalizeFinding(finding);
    const findings = await this.projections.listFindings(normalized.missionId);
    const duplicate = findings.find(item => item.id === normalized.id);
    if (!duplicate) {
      await this.controller.emit(
        normalized.missionId,
        "finding.created",
        { finding: normalized },
        { type: "verifier" },
        `finding:${normalized.id}`
      );
    }
    if (options.createGap === false) return { finding: duplicate ?? normalized, gap: null, action: duplicate ? "duplicate" : "recorded" };

    const gaps = await this.projections.listGaps(normalized.missionId);
    const matched = this.clusterer.find(normalized, gaps);
    if (!matched) {
      const gap = this.clusterer.create(normalized, options);
      await this.controller.openGap(normalized.missionId, {
        id: gap.id,
        severity: gap.severity,
        description: gap.description,
        category: gap.category,
        requirementRefs: gap.requirementRefs,
        artifactRefs: gap.artifactRefs,
        findingRefs: gap.findingRefs
      });
      await this.controller.emit(
        normalized.missionId,
        "gap.updated",
        { gap },
        { type: "verifier" },
        `gap-cluster-init:${gap.id}:${normalized.id}`
      );
      return { finding: normalized, gap, action: "created_gap" };
    }

    const merged = this.clusterer.merge(matched, normalized, options);
    if (duplicate && matched.findingRefs.includes(normalized.id)) {
      return { finding: duplicate, gap: matched, action: "duplicate" };
    }
    if (matched.status === "resolved") {
      const reopened: Gap = { ...merged, status: "open", resolvedAt: undefined };
      await this.controller.emit(
        normalized.missionId,
        "gap.reopened",
        { gap: reopened },
        { type: "verifier" },
        `gap-reopened:${reopened.id}:${normalized.id}`
      );
      return { finding: normalized, gap: reopened, action: "reopened_gap" };
    }
    const updated: Gap = { ...merged, status: matched.status };
    await this.controller.emit(
      normalized.missionId,
      "gap.updated",
      { gap: updated },
      { type: "verifier" },
      `gap-updated:${updated.id}:${normalized.id}`
    );
    return { finding: normalized, gap: updated, action: "updated_gap" };
  }
}
