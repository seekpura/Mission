import type { CapabilityCandidate, SecurityAssessment } from "../domain/capability.ts";
import { StaticSecurityScanner } from "./static-security-scanner.ts";
import type { CandidateInspector } from "./acquisition-service.ts";
import type { CandidateMaterializer } from "./materializer.ts";

export class FilesystemCandidateInspector implements CandidateInspector {
  private readonly materializer: CandidateMaterializer;
  private readonly scanner: StaticSecurityScanner;
  constructor(materializer: CandidateMaterializer, scanner = new StaticSecurityScanner()) {
    this.materializer = materializer;
    this.scanner = scanner;
  }
  async inspect(candidate: CapabilityCandidate): Promise<SecurityAssessment> {
    const materialized = await this.materializer.materialize(candidate);
    return this.scanner.scan(materialized.candidate, materialized.root);
  }
}
