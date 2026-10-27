import type { CapabilityDescriptor } from "../domain/capability.ts";

export class MissionCapabilityOverlay {
  private readonly byMission = new Map<string, Map<string, CapabilityDescriptor>>();

  activate(missionId: string, capability: CapabilityDescriptor) {
    const current = this.byMission.get(missionId) ?? new Map<string, CapabilityDescriptor>();
    current.set(capability.id, { ...capability, scope: "mission", available: true });
    this.byMission.set(missionId, current);
  }

  deactivate(missionId: string, capabilityId: string) {
    this.byMission.get(missionId)?.delete(capabilityId);
  }

  list(missionId: string): CapabilityDescriptor[] {
    return [...(this.byMission.get(missionId)?.values() ?? [])];
  }

  effective(missionId: string, hostCapabilities: CapabilityDescriptor[]) {
    const merged = new Map(hostCapabilities.map(c => [c.id, c]));
    for (const cap of this.list(missionId)) merged.set(cap.id, cap);
    return [...merged.values()];
  }
}
