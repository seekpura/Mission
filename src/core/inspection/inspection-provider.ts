import type { Artifact } from "../domain/artifact.ts";
import type { InspectionBundle, InspectionContext, InspectionRequest } from "../domain/inspection.ts";

export interface InspectionProvider {
  id: string;
  version?: string;
  supports(artifact: Artifact, request: InspectionRequest): boolean;
  inspect(artifact: Artifact, request: InspectionRequest, context: InspectionContext): Promise<InspectionBundle>;
}
