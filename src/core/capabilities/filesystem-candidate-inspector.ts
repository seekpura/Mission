import type { CapabilityCandidate, SecurityAssessment } from "../domain/capability.ts";
import { StaticSecurityScanner } from "./static-security-scanner.ts";
import type { CandidateInspector } from "./acquisition-service.ts";

export interface CandidateMaterializer {
  materialize(candidate: CapabilityCandidate): Promise<string>;
}

export class FilesystemCandidateInspector implements CandidateInspector {
  private readonly materializer: CandidateMaterializer;
  private readonly scanner: StaticSecurityScanner;
  constructor(materializer: CandidateMaterializer, scanner = new StaticSecurityScanner()) {
    this.materializer = materializer;
    this.scanner = scanner;
  }
  async inspect(candidate: CapabilityCandidate): Promise<SecurityAssessment> {
    const root = await this.materializer.materialize(candidate);
    return this.scanner.scan(candidate, root);
  }
}
