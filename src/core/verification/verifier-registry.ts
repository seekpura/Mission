import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck } from "../domain/verification.ts";
import type { VerificationCheckExecutor } from "./check-executor.ts";

export class VerifierRegistry {
  private readonly executors: VerificationCheckExecutor[];
  constructor(executors: VerificationCheckExecutor[] = []) { this.executors = [...executors]; }
  register(executor: VerificationCheckExecutor): void { this.executors.push(executor); }
  resolve(check: VerificationCheck, artifact: Artifact): VerificationCheckExecutor | undefined {
    return this.executors.find(executor => executor.supports(check, artifact));
  }
}
