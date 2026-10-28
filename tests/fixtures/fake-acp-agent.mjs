import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const statePath = join(process.cwd(), ".fake-acp-sessions.json");
const sessions = loadSessions();

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);

acp
  .agent({ name: "mission-fake-acp-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      sessionCapabilities: {
        resume: {},
        close: {}
      }
    }
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = `fake-session-${process.pid}-${Date.now()}`;
    sessions.set(sessionId, { cwd: params.cwd, cancelled: false });
    persistSessions();
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.resume, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session ${params.sessionId}`);
    if (session.cwd !== params.cwd) throw new Error(`cwd mismatch for ${params.sessionId}`);
    session.cancelled = false;
    persistSessions();
    return {};
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session ${params.sessionId}`);
    const promptText = params.prompt
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n");
    const recoveryTurn = promptText.includes("Mission Runtime recovery continuation.");

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: recoveryTurn ? "fake agent resumed" : "fake agent started" }
      }
    });

    if (promptText.includes('"disconnectForRecovery": true') && !recoveryTurn) {
      persistSessions();
      process.exit(70);
    }

    if (promptText.includes('"waitForCancel": true')) {
      while (!session.cancelled) await new Promise(resolve => setTimeout(resolve, 10));
      return { stopReason: "cancelled" };
    }

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "fake-edit-1",
        title: "Edit fake artifact",
        kind: "edit",
        status: "pending",
        rawInput: { path: "artifact.txt" }
      }
    });

    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId: "fake-edit-1",
        title: "Edit fake artifact",
        kind: "edit",
        status: "pending",
        rawInput: { path: "artifact.txt" }
      },
      options: [
        { kind: "allow_once", name: "Allow once", optionId: "allow" },
        { kind: "reject_once", name: "Reject once", optionId: "reject" }
      ]
    });

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "fake-edit-1",
        status: permission.outcome.outcome === "selected" && permission.outcome.optionId === "allow"
          ? "completed"
          : "failed",
        rawOutput: { permission: permission.outcome }
      }
    });

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: recoveryTurn ? "fake agent recovery finished" : "fake agent finished" }
      }
    });

    return { stopReason: session.cancelled ? "cancelled" : "end_turn" };
  })
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    sessions.delete(params.sessionId);
    persistSessions();
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (session) {
      session.cancelled = true;
      persistSessions();
    }
  })
  .connect(stream);

function loadSessions() {
  if (!existsSync(statePath)) return new Map();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function persistSessions() {
  writeFileSync(statePath, `${JSON.stringify(Object.fromEntries(sessions), null, 2)}\n`, "utf8");
}
