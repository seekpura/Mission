from pathlib import Path

path = Path("src/runtime/bootstrap.ts")
text = path.read_text(encoding="utf-8")


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"bootstrap recovery patch expected exactly one match, found {count}: {old!r}")
    text = text.replace(old, new)


replace_once(
    '''  let closed = false;
  let shutdownPromise: Promise<RuntimeShutdownResult> | undefined;
  const lifecycle = { supervisor, host, approvals, database };
''',
    '''  let closed = false;
  let shutdownStarted = false;
  let shutdownPromise: Promise<RuntimeShutdownResult> | undefined;
  let recoveryPromise: Promise<string[]> | undefined;
  const lifecycle = { supervisor, host, approvals, database };
''',
)
replace_once(
    '''    async recoverExistingMissions(): Promise<string[]> {
      const resumed: string[] = [];
      for (const missionId of await catalog.listMissionIds()) {
        await approvals.rejectStalePending(missionId);
        const state = await controller.state(missionId);
        if (state.status === "completed" || state.status === "cancelled" || state.status === "failed") continue;
        void supervisor.wake(missionId, "manual");
        resumed.push(missionId);
      }
      return resumed;
    },
''',
    '''    recoverExistingMissions(): Promise<string[]> {
      if (shutdownStarted || closed) return Promise.resolve([]);
      if (recoveryPromise) return recoveryPromise;
      recoveryPromise = (async () => {
        const resumed: string[] = [];
        for (const missionId of await catalog.listMissionIds()) {
          if (shutdownStarted) break;
          await approvals.rejectStalePending(missionId);
          const state = await controller.state(missionId);
          if (state.status === "completed" || state.status === "cancelled" || state.status === "failed") continue;
          if (shutdownStarted) break;
          void supervisor.wake(missionId, "manual");
          resumed.push(missionId);
        }
        return resumed;
      })().finally(() => {
        recoveryPromise = undefined;
      });
      return recoveryPromise;
    },
''',
)
replace_once(
    '''      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = shutdownMissionRuntime(lifecycle, shutdownOptions)
        .then(result => {
''',
    '''      if (shutdownPromise) return shutdownPromise;
      shutdownStarted = true;
      shutdownPromise = (async () => {
        if (recoveryPromise) await recoveryPromise;
        return shutdownMissionRuntime(lifecycle, shutdownOptions);
      })()
        .then(result => {
''',
)
replace_once(
    '''    close(): void {
      if (closed) return;
      closeMissionRuntimeIfIdle(lifecycle);
''',
    '''    close(): void {
      if (closed) return;
      shutdownStarted = true;
      if (recoveryPromise) throw new Error("Cannot synchronously close Mission Runtime while startup recovery is active");
      closeMissionRuntimeIfIdle(lifecycle);
''',
)

path.write_text(text, encoding="utf-8")
