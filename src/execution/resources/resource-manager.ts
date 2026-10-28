export interface ResourceLease {
  ownerId: string;
  resources: string[];
  release(): void;
}

export class ResourceManager {
  private readonly holders = new Map<string, string>();
  private waiters: Array<() => void> = [];

  async acquire(ownerId: string, resources: string[]): Promise<ResourceLease> {
    const requested = [...new Set(resources)].sort();
    if (requested.length === 0) return { ownerId, resources: [], release() {} };
    while (!this.canAcquire(ownerId, requested)) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    for (const resource of requested) this.holders.set(resource, ownerId);
    let released = false;
    return {
      ownerId,
      resources: requested,
      release: () => {
        if (released) return;
        released = true;
        for (const resource of requested) {
          if (this.holders.get(resource) === ownerId) this.holders.delete(resource);
        }
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters) waiter();
      }
    };
  }

  private canAcquire(ownerId: string, resources: string[]): boolean {
    return resources.every(resource => !this.holders.has(resource) || this.holders.get(resource) === ownerId);
  }
}
