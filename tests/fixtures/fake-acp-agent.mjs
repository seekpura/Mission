import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const sessions = new Map();
let nextSession = 1;

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);

acp
  .agent({ name: "mission-fake-acp-agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false }
  }))
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = `fake-session-${nextSession++}`;
    sessions.set(sessionId, { cwd: params.cwd, cancelled: false });
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session ${params.sessionId}`);

    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fake agent started" }
      }
    });

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
        content: { type: "text", text: "fake agent finished" }
      }
    });

    return { stopReason: session.cancelled ? "cancelled" : "end_turn" };
  })
  .onRequest(acp.methods.agent.session.close, ({ params }) => {
    sessions.delete(params.sessionId);
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (session) session.cancelled = true;
  })
  .connect(stream);
