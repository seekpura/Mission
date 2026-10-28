from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")


adapter = "src/hosts/codex/codex-app-server-host-adapter.ts"
replace_once(
    adapter,
    "interface RunningAgent {\n  request: AgentCreateRequest;\n",
    "interface BufferedNotification {\n  method: string;\n  params: unknown;\n}\n\nconst MAX_STARTUP_NOTIFICATIONS = 512;\n\ninterface RunningAgent {\n  request: AgentCreateRequest;\n",
)
replace_once(
    adapter,
    "  finished: boolean;\n  toolCalls: Map<string, CachedToolCall>;\n",
    "  finished: boolean;\n  toolCalls: Map<string, CachedToolCall>;\n  startupNotifications?: BufferedNotification[];\n  startupNotificationOverflow?: boolean;\n",
)
old_start = '''  private async startTurn(running: RunningAgent, prompt: string, resumed: boolean): Promise<void> {
    const response = asRecord(await running.rpc.request("turn/start", {
      threadId: running.threadId,
      input: [{ type: "text", text: prompt }],
      cwd: running.request.workspaceRoot ?? process.cwd()
    }));
    const turn = asRecord(response.turn);
    running.turnId = requiredString(turn.id, "Codex turn/start response.turn.id");
    running.events.push(event("started", {
      nativeSessionId: running.threadId,
      nativeTurnId: running.turnId,
      workspaceRoot: running.request.workspaceRoot ?? process.cwd(),
      transport: "codex-app-server-jsonrpc-v2",
      resumed
    }));
  }
'''
new_start = '''  private async startTurn(running: RunningAgent, prompt: string, resumed: boolean): Promise<void> {
    running.startupNotifications = [];
    running.startupNotificationOverflow = false;
    let response: Record<string, unknown>;
    try {
      response = asRecord(await running.rpc.request("turn/start", {
        threadId: running.threadId,
        input: [{ type: "text", text: prompt }],
        cwd: running.request.workspaceRoot ?? process.cwd()
      }));
    } catch (error) {
      running.startupNotifications = undefined;
      running.startupNotificationOverflow = undefined;
      throw error;
    }
    if (running.startupNotificationOverflow) {
      running.startupNotifications = undefined;
      running.startupNotificationOverflow = undefined;
      throw new Error(`Codex emitted more than ${MAX_STARTUP_NOTIFICATIONS} notifications before turn/start completed`);
    }
    const buffered = running.startupNotifications ?? [];
    running.startupNotifications = undefined;
    running.startupNotificationOverflow = undefined;
    const turn = asRecord(response.turn);
    running.turnId = requiredString(turn.id, "Codex turn/start response.turn.id");
    running.events.push(event("started", {
      nativeSessionId: running.threadId,
      nativeTurnId: running.turnId,
      workspaceRoot: running.request.workspaceRoot ?? process.cwd(),
      transport: "codex-app-server-jsonrpc-v2",
      resumed
    }));
    for (const notification of buffered) {
      this.handleNotification(running, notification.method, notification.params);
    }
  }
'''
replace_once(adapter, old_start, new_start)
replace_once(
    adapter,
    '''  private handleNotification(running: RunningAgent, method: string, params: unknown): void {
    if (running.finished) return;
    const record = asRecord(params);
''',
    '''  private handleNotification(running: RunningAgent, method: string, params: unknown): void {
    if (running.finished) return;
    if (running.startupNotifications !== undefined) {
      if (running.startupNotifications.length >= MAX_STARTUP_NOTIFICATIONS) {
        running.startupNotificationOverflow = true;
        return;
      }
      running.startupNotifications.push({ method, params });
      return;
    }
    const record = asRecord(params);
''',
)

test = "tests/integration/codex-app-server-host-adapter.test.ts"
replace_once(
    test,
    "let pendingApprovalTurn = null;\n",
    "let pendingApprovalTurn = null;\nlet resumedThread = false;\n",
)
replace_once(
    test,
    '''    } else {
      reply(message.id, { thread: { id: message.params.threadId }, model: "fake", modelProvider: "fake" });
    }
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
''',
    '''    } else {
      resumedThread = true;
      reply(message.id, { thread: { id: message.params.threadId }, model: "fake", modelProvider: "fake" });
    }
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
''',
)
replace_once(
    test,
    '''    reply(message.id, { turn: { id: currentTurn, status: "inProgress" } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: message.params.threadId, turn: { id: currentTurn, status: "inProgress" } } });
''',
    '''    if (!resumedThread) reply(message.id, { turn: { id: currentTurn, status: "inProgress" } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: message.params.threadId, turn: { id: currentTurn, status: "inProgress" } } });
''',
)
replace_once(
    test,
    '''    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: currentTurn, delta: "hello from codex" } });
    terminal("completed");
    return;
''',
    '''    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: currentTurn, delta: "hello from codex" } });
    terminal("completed");
    if (resumedThread) {
      resumedThread = false;
      reply(message.id, { turn: { id: currentTurn, status: "inProgress" } });
    }
    return;
''',
)
