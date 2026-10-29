import type { RuntimeShutdownOptions, RuntimeShutdownResult } from "../runtime/runtime-shutdown.ts";
import type { MissionApiServer } from "./mission-api.ts";

export interface ShutdownCapableRuntime {
  shutdown(options?: RuntimeShutdownOptions): Promise<RuntimeShutdownResult>;
}

/**
 * Stop HTTP admission, end long-lived passive streams, wait for already
 * admitted request handlers to leave their database transaction boundary,
 * then drain Mission execution and close Runtime resources.
 */
export async function shutdownHttpRuntime(
  server: MissionApiServer,
  runtime: ShutdownCapableRuntime,
  options: RuntimeShutdownOptions = {}
): Promise<RuntimeShutdownResult> {
  server.beginDrain();
  const serverClosed = closeServer(server);
  server.closeIdleConnections?.();

  await server.waitForRequestDrain();
  try {
    return await runtime.shutdown(options);
  } finally {
    server.closeAllConnections?.();
    await serverClosed;
  }
}

function closeServer(server: MissionApiServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
