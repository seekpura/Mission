import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome
} from "./work-execution-driver.ts";

export interface ExecutorRoute {
  executorId: string;
  driver: WorkExecutionDriver;
}

export interface ExecutorRouterOptions {
  defaultExecutorId?: string;
}

/**
 * Routes WorkItems to execution drivers without inferring executor semantics.
 * Planner/controller assignment remains explicit through WorkItem.assignedExecutorId.
 */
export class ExecutorRouter implements WorkExecutionDriver {
  readonly id = "executor-router";
  private readonly routes = new Map<string, WorkExecutionDriver>();
  private readonly defaultExecutorId?: string;

  constructor(routes: ExecutorRoute[], options: ExecutorRouterOptions = {}) {
    if (routes.length === 0) throw new Error("ExecutorRouter requires at least one route");
    for (const route of routes) {
      if (!route.executorId.trim()) throw new Error("Executor route requires a non-empty executorId");
      if (this.routes.has(route.executorId)) {
        throw new Error(`Duplicate executor route: ${route.executorId}`);
      }
      this.routes.set(route.executorId, route.driver);
    }

    if (options.defaultExecutorId && !this.routes.has(options.defaultExecutorId)) {
      throw new Error(`Unknown default executor route: ${options.defaultExecutorId}`);
    }
    this.defaultExecutorId = options.defaultExecutorId;
  }

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    const executorId = this.resolveExecutorId(input);
    const driver = this.routes.get(executorId);
    if (!driver) throw new Error(`No execution driver registered for executor: ${executorId}`);
    return driver.execute(input);
  }

  private resolveExecutorId(input: WorkExecutionInput): string {
    if (input.workItem.assignedExecutorId) return input.workItem.assignedExecutorId;
    if (this.defaultExecutorId) return this.defaultExecutorId;
    if (this.routes.size === 1) return this.routes.keys().next().value as string;
    throw new Error(
      `Work item ${input.workItem.id} has no assignedExecutorId and multiple executor routes are available`
    );
  }
}
