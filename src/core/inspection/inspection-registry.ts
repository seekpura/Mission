import type { Artifact } from "../domain/artifact.ts";
import type { InspectionRequest } from "../domain/inspection.ts";
import type { InspectionProvider } from "./inspection-provider.ts";

export class InspectionProviderRegistry {
  private readonly providers: InspectionProvider[];
  constructor(providers: InspectionProvider[] = []) { this.providers = [...providers]; }
  register(provider: InspectionProvider): void { this.providers.push(provider); }
  resolve(artifact: Artifact, request: InspectionRequest): InspectionProvider | undefined {
    return this.providers.find(provider => provider.supports(artifact, request));
  }
}
