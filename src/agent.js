// One CallAgent per phone call. Keeps the conversation history and runs
// Claude + tools for each thing the caller says.
import { streamClaude } from './claude.js';
import { buildSystemPrompt } from './prompt.js';
import { toolDefinitions, runTool } from './tools.js';

const MAX_TOOL_ROUNDS = 4;

export class CallAgent {
  constructor({ callSid, callerNumber, dryRun = false, onToolCall }) {
    this.messages = [];
    this.endRequest = null; // set when Claude calls end_call / transfer_to_owner
    this.onToolCall = onToolCall;
    this.ctx = {
      callSid,
      callerNumber,
      dryRun,
      textsSent: 0,
      requestEnd: (handoff) => {
        this.endRequest = handoff;
      },
    };
  }

  /**
   * Handles one thing the caller said. Streams spoken text through onText.
   * Returns the full text spoken this turn.
   */
  async handleUserTurn(userText, { onText, signal } = {}) {
    this.messages.push({ role: 'user', content: userText });
    let spoken = '';
    let partial = '';

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        partial = '';
        const { content, stopReason } = await streamClaude({
          system: buildSystemPrompt(),
          messages: this.messages,
          tools: toolDefinitions,
          signal,
          onText: (t) => {
            partial += t;
            spoken += t;
            onText?.(t);
          },
        });

        if (content.length === 0) content.push({ type: 'text', text: '...' });
        this.messages.push({ role: 'assistant', content });

        if (stopReason !== 'tool_use') break;

        const results = [];
        for (const block of content.filter((b) => b.type === 'tool_use')) {
          this.onToolCall?.(block.name, block.input);
          const result = await runTool(block.name, block.input, this.ctx);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        }
        this.messages.push({ role: 'user', content: results });

        // Hanging up or transferring: the goodbye was already said, stop here.
        if (this.endRequest) break;
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Caller interrupted while Claude was still writing. Keep history valid.
        this.messages.push({ role: 'assistant', content: [{ type: 'text', text: partial.trim() || '...' }] });
        return spoken;
      }
      throw err;
    }
    return spoken;
  }

  /**
   * The caller cut the agent off. Replace the last reply with only the part
   * they actually heard, so Claude doesn't think it said things it didn't.
   */
  noteInterruption(heardText) {
    const last = this.messages.at(-1);
    if (!last || last.role !== 'assistant') return;
    const onlyText = last.content.every((b) => b.type === 'text');
    if (!onlyText) return;
    const heard = (heardText || '').trim();
    last.content = [{ type: 'text', text: heard ? `${heard}... [interrupted by caller]` : '[interrupted by caller]' }];
  }
}
