import type { Server } from "node:http";
import type { RuntimeShutdownOptions, RuntimeShutdownResult } from "../runtime/runtime-shutdown.ts";

export interface ShutdownCapableRuntime {
  shutdown(options?: RuntimeShutdownOptions): Promise<RuntimeShutdownResult>;
}

/**
 * Stop accepting new HTTP connections first, allow already-admitted Mission
 * work to drain through Runtime shutdown, then close long-lived transports
 * such as SSE so the HTTP server can finish closing.
 */
export async function shutdownHttpRuntime(
  server: Server,
  runtime: ShutdownCapableRuntime,
  options: RuntimeShutdownOptions = {}
): Promise<RuntimeShutdownResult> {
  const serverClosed = closeServer(server);
  server.closeIdleConnections?.();
  try {
    return await runtime.shutdown(options);
  } finally {
    server.closeAllConnections?.();
    await serverClosed;
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
