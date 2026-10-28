from pathlib import Path

path = Path("src/runtime/bootstrap.ts")
text = path.read_text(encoding="utf-8")


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"bootstrap patch expected exactly one match, found {count}: {old!r}")
    text = text.replace(old, new)


replace_once(
    'import { MissionSupervisor } from "./mission-supervisor.ts";\n',
    'import { MissionSupervisor } from "./mission-supervisor.ts";\nimport { DrainableHostAdapter } from "./drainable-host-adapter.ts";\nimport {\n  closeMissionRuntimeIfIdle,\n  shutdownMissionRuntime,\n  type RuntimeShutdownOptions,\n  type RuntimeShutdownResult\n} from "./runtime-shutdown.ts";\n',
)
replace_once(
    '  recoverExistingMissions(): Promise<string[]>;\n  close(): void;\n',
    '  recoverExistingMissions(): Promise<string[]>;\n  shutdown(options?: RuntimeShutdownOptions): Promise<RuntimeShutdownResult>;\n  close(): void;\n',
)
replace_once(
    '  const host = new SideEffectHostAdapter(capabilityHost, sideEffects, { scopeRegistry: sideEffectScopes });\n',
    '  const sideEffectHost = new SideEffectHostAdapter(capabilityHost, sideEffects, { scopeRegistry: sideEffectScopes });\n  const host = new DrainableHostAdapter(sideEffectHost);\n',
)
replace_once(
    '  const supervisor = new MissionSupervisor(controller, events, { maxCyclesPerWake: options.maxSupervisorCycles });\n\n  return {\n',
    '  const supervisor = new MissionSupervisor(controller, events, { maxCyclesPerWake: options.maxSupervisorCycles });\n  let closed = false;\n  let shutdownPromise: Promise<RuntimeShutdownResult> | undefined;\n  const lifecycle = { supervisor, host, approvals, database };\n\n  return {\n',
)
replace_once(
    '''    close(): void {
      approvals.dispose();
      database.close();
    }
''',
    '''    shutdown(shutdownOptions: RuntimeShutdownOptions = {}): Promise<RuntimeShutdownResult> {
      if (closed) {
        return Promise.resolve({ forced: false, cancelledHandleIds: [], cancellationFailures: [] });
      }
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = shutdownMissionRuntime(lifecycle, shutdownOptions)
        .then(result => {
          closed = true;
          return result;
        })
        .catch(error => {
          shutdownPromise = undefined;
          throw error;
        });
      return shutdownPromise;
    },
    close(): void {
      if (closed) return;
      closeMissionRuntimeIfIdle(lifecycle);
      closed = true;
    }
''',
)

path.write_text(text, encoding="utf-8")
