import type { Finding, Gap } from "../../core/domain/verification.ts";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { MissionDatabase } from "./database.ts";

export class SqliteAssuranceProjector {
  private readonly database: MissionDatabase;
  constructor(database: MissionDatabase) { this.database = database; }

  apply(event: MissionEvent): void {
    const db = this.database.db;
    const payload = event.payload as any;
    switch (event.type) {
      case "finding.created": {
        const finding = (payload.finding ?? payload) as Finding;
        if (!finding?.id) return;
        db.prepare(`INSERT OR REPLACE INTO findings
          (id, mission_id, severity, category, data_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(finding.id, event.missionId, finding.severity, finding.category, JSON.stringify(finding), finding.createdAt ?? event.createdAt);
        return;
      }
      case "gap.updated":
      case "gap.reopened": {
        const incoming = (payload.gap ?? payload) as Gap;
        if (!incoming?.id) return;
        const row = db.prepare("SELECT data_json, opened_at FROM gaps WHERE id = ? AND mission_id = ?")
          .get(incoming.id, event.missionId) as { data_json: string; opened_at: string } | undefined;
        const current = row ? JSON.parse(row.data_json) as Gap : undefined;
        const gap: Gap = {
          ...current,
          ...incoming,
          missionId: event.missionId,
          findingRefs: unique([...(current?.findingRefs ?? []), ...(incoming.findingRefs ?? [])]),
          requirementRefs: unique([...(current?.requirementRefs ?? []), ...(incoming.requirementRefs ?? [])]),
          artifactRefs: unique([...(current?.artifactRefs ?? []), ...(incoming.artifactRefs ?? [])]),
          status: event.type === "gap.reopened" ? "open" : incoming.status ?? current?.status ?? "open",
          openedAt: current?.openedAt ?? row?.opened_at ?? incoming.openedAt ?? event.createdAt,
          resolvedAt: event.type === "gap.reopened" ? undefined : incoming.resolvedAt ?? current?.resolvedAt,
          lastObservedAt: incoming.lastObservedAt ?? event.createdAt,
          occurrenceCount: Math.max(incoming.occurrenceCount ?? 0, current?.occurrenceCount ?? 0)
        };
        db.prepare(`INSERT INTO gaps
          (id, mission_id, category, severity, status, description, data_json, opened_at, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            category = excluded.category,
            severity = excluded.severity,
            status = excluded.status,
            description = excluded.description,
            data_json = excluded.data_json,
            resolved_at = excluded.resolved_at`)
          .run(gap.id, gap.missionId, gap.category, gap.severity, gap.status, gap.description, JSON.stringify(gap), gap.openedAt, gap.resolvedAt ?? null);
        return;
      }
    }
  }
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
