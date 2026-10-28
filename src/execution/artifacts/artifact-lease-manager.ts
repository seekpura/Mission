export interface ArtifactWriteLease {
  ownerId: string;
  logicalNames: string[];
  release(): void;
}

export class ArtifactLeaseManager {
  private readonly writers = new Map<string, string>();
  private waiters: Array<() => void> = [];

  async acquireWrite(ownerId: string, logicalNames: string[]): Promise<ArtifactWriteLease> {
    const requested = [...new Set(logicalNames.filter(Boolean))].sort();
    if (requested.length === 0) return { ownerId, logicalNames: [], release() {} };
    while (!requested.every(name => !this.writers.has(name) || this.writers.get(name) === ownerId)) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    for (const name of requested) this.writers.set(name, ownerId);
    let released = false;
    return {
      ownerId,
      logicalNames: requested,
      release: () => {
        if (released) return;
        released = true;
        for (const name of requested) if (this.writers.get(name) === ownerId) this.writers.delete(name);
        this.wakeWaiters();
      }
    };
  }

  releaseOwner(ownerId: string): void {
    for (const [name, owner] of [...this.writers.entries()]) if (owner === ownerId) this.writers.delete(name);
    this.wakeWaiters();
  }

  isHeld(logicalName: string): boolean { return this.writers.has(logicalName); }

  private wakeWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}
