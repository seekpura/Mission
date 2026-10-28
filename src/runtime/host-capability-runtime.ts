import type { CapabilityDescriptor, CapabilityNeed } from "../core/domain/capability.ts";
import type { CapabilityEnsureResult, CapabilityRuntime } from "../core/capabilities/capability-coordinator.ts";
import { MissionCapabilityOverlay } from "../core/capabilities/mission-capability-overlay.ts";
import { CapabilityResolver } from "../core/capabilities/resolver.ts";
import type { HostAdapter } from "../hosts/deepseek/host-adapter.ts";

/**
 * Production-safe baseline capability runtime. It resolves host-native and
 * already-activated mission capabilities, but never pretends external
 * acquisition is available without a configured strong-isolation acquisition
 * stack. A later bootstrap can replace this object with CapabilityCoordinator.
 */
export class HostCapabilityRuntime implements CapabilityRuntime {
  private readonly host: HostAdapter;
  private readonly overlay: MissionCapabilityOverlay;
  private readonly resolver: CapabilityResolver;

  constructor(host: HostAdapter, overlay = new MissionCapabilityOverlay(), resolver = new CapabilityResolver()) {
    this.host = host;
    this.overlay = overlay;
    this.resolver = resolver;
  }

  restoreMissionCapabilities(missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    for (const capability of capabilities) {
      if (capability.hostNative || !capability.available) continue;
      this.overlay.activate(missionId, capability);
    }
  }

  async ensure(need: CapabilityNeed): Promise<CapabilityEnsureResult> {
    const snapshot = await this.host.snapshotEnvironment();
    const effective = this.overlay.effective(need.missionId, snapshot.capabilities);
    const resolved = this.resolver.resolve(need, effective);
    if (resolved.status === "resolved" && resolved.capability) {
      return {
        status: "resolved",
        capability: resolved.capability,
        source: "host-or-overlay",
        attempts: [],
        reason: resolved.reason
      };
    }
    return {
      status: "missing",
      source: "none",
      attempts: [],
      reason: need.acquisitionAllowed
        ? `${resolved.reason}; external acquisition is fail-closed because this runtime has no configured strong-isolation acquisition transport`
        : `${resolved.reason}; acquisition is disabled for this need`
    };
  }
}
