import { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'

let nextCall = 0

function assistantCalls(messages) {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call').map(block => block.name)
    : [])
}

function userText(messages) {
  return messages.flatMap(message => message.role === 'user'
    ? message.content.filter(block => block.type === 'text').map(block => block.text)
    : []).join('\n')
}

function toolText(messages) {
  return messages.flatMap(message => message.role === 'tool'
    ? message.content.filter(block => block.type === 'text').map(block => block.text)
    : []).join('\n')
}

function toolChunks(name, args) {
  const id = ToolCallId(`mission-live-${++nextCall}`)
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 12 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function missionIdFromToolText(text) {
  const match = text.match(/\\?"missionId\\?"\s*:\s*\\?"([^"\\]+)\\?"/)
  return match?.[1]
}

function requireTool(tools, name) {
  if (!tools.includes(name)) throw new Error(`DSH live composition is missing required tool: ${name}; tools=${tools.join(',')}`)
}

function deliberation(text) {
  if (text.includes('Mission Runtime Interpreter and Acceptance Composer')) {
    return JSON.stringify({
      missionSpec: {
        objective: 'Create live-deliverable.txt containing LIVE_DSH_OK',
        intent: 'Prove Mission Runtime through the real DeepSeek Harness composition',
        requestedOutputs: ['live-deliverable'], constraints: [], preferences: [], sourceRefs: [],
      },
      acceptanceContract: {
        requirements: [{ id: 'R1', description: 'Create the requested live deliverable', type: 'functional', priority: 'required', verification: 'artifact' }],
        requiredArtifacts: [{ logicalName: 'live-deliverable', type: 'document', description: 'Live DSH-created deliverable', requirementRefs: ['R1'] }],
        requiredValidations: [{ id: 'structural', description: 'Deliverable exists and is non-empty', level: 'structural', requirementRefs: ['R1'] }],
        criticalFailureConditions: [],
      },
    })
  }
  if (text.includes('Mission Runtime Strategy Composer')) {
    return JSON.stringify({ framing: 'real DSH vertical slice', approach: 'produce one durable artifact then verify it', workstreams: [{ id: 'delivery', objective: 'create the requested live artifact' }], revision: 1 })
  }
  if (text.includes('Mission Runtime Frontier Planner')) {
    return JSON.stringify({
      graphRevision: 1,
      capabilityNeeds: [],
      workItems: [{
        id: 'live-produce', purpose: 'production', objective: 'Create live-deliverable.txt in the assigned Mission workspace with exact text LIVE_DSH_OK',
        requirementRefs: ['R1'], gapRefs: [], inputArtifactRefs: [], capabilityNeedRefs: [], priority: 100,
        expectedOutputs: [{ logicalName: 'live-deliverable', type: 'document', required: true }],
      }],
    })
  }
  if (text.includes('independent Mission Completion Challenger')) {
    return JSON.stringify({ blockingObjection: false, objections: [], confidence: 1 })
  }
  if (text.includes('Mission Runtime Gap Diagnostician')) {
    return JSON.stringify({ gapId: 'unknown', rootCause: 'unexpected live smoke gap', hypotheses: [], repairScope: 'work_item', intervention: 'revise_work', confidence: 0.8, evidenceRefs: [], rootCauseKeyCandidate: null })
  }
  return undefined
}

function workerResponse(messages, tools, prompt) {
  const calls = assistantCalls(messages)
  requireTool(tools, 'bash')
  if (!calls.includes('bash')) {
    return toolChunks('bash', {
      description: 'Write the Mission live smoke artifact',
      command: "printf 'LIVE_DSH_OK\\n' > live-deliverable.txt",
    })
  }
  return textChunks(JSON.stringify({
    status: 'completed',
    summary: 'Created the live DSH artifact through the real bash tool.',
    outputs: [{ path: 'live-deliverable.txt', logicalName: 'live-deliverable', type: 'document', requirementRefs: ['R1'] }],
    proposedFacts: [], proposedWork: [], warnings: [],
  }))
}

function rootResponse(messages, tools) {
  requireTool(tools, 'mission_start')
  requireTool(tools, 'mission_cycle')
  requireTool(tools, 'mission_status')
  const calls = assistantCalls(messages)
  const results = toolText(messages)
  if (!calls.includes('mission_start')) {
    return toolChunks('mission_start', { goal: 'Create live-deliverable.txt containing LIVE_DSH_OK and verify it.' })
  }
  const missionId = missionIdFromToolText(results)
  if (!missionId) throw new Error(`mission_start result did not expose missionId: ${results.slice(-1000)}`)
  if (!calls.includes('mission_cycle')) return toolChunks('mission_cycle', { mission_id: missionId })
  if (!calls.includes('mission_status')) return toolChunks('mission_status', { mission_id: missionId })
  if (!results.includes('"status":"completed"') && !results.includes('\\"status\\":\\"completed\\"')) {
    throw new Error(`Mission did not complete through real DSH composition: ${results.slice(-2000)}`)
  }
  return textChunks(`DSH_MISSION_OK ${missionId}`)
}

class MissionLiveAdapter extends LlmAdapter {
  async * stream(options) {
    const prompt = userText(options.messages)
    const tools = options.tools.map(tool => tool.name)
    let chunks
    const scripted = deliberation(prompt)
    if (scripted !== undefined) chunks = textChunks(scripted)
    else if (prompt.includes('You are a Mission Runtime worker.')) chunks = workerResponse(options.messages, tools, prompt)
    else chunks = rootResponse(options.messages, tools)
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

export const name = 'mission-live-mock-llm'
export const inject = ['llm']

export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['deepseek-official'], new MissionLiveAdapter()))
}
