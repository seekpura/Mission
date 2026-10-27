import type { CapabilityCandidate, CapabilityNeed } from "../domain/capability.ts";

export interface CapabilityDiscoveryProvider {
  id: string;
  discover(need: CapabilityNeed): Promise<CapabilityCandidate[]>;
}
