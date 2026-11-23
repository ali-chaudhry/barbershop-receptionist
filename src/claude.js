// Calls the Claude Messages API with streaming, so the caller starts hearing
// the reply as soon as the first words are ready.
const API_URL = `${process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`;

/**
 * Streams one Claude turn.
 * @param {object} opts
 * @param {string} opts.system
 * @param {Array} opts.messages
 * @param {Array} opts.tools
 * @param {(text: string) => void} opts.onText  called with each text chunk
 * @param {AbortSignal} [opts.signal]           abort when the caller interrupts
 * @returns {Promise<{content: Array, stopReason: string}>}
 */
export async function streamClaude({ system, messages, tools, onText, signal }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
      max_tokens: 400,
      system,
      messages,
      tools,
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API error ${res.status}: ${body}`);
  }

  const blocks = []; // content blocks in order
  let stopReason = null;
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    // Server-sent events are separated by a blank line
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = rawEvent.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(5).trim());

      switch (event.type) {
        case 'content_block_start': {
          const cb = event.content_block;
          if (cb.type === 'text') blocks[event.index] = { type: 'text', text: '' };
          else if (cb.type === 'tool_use')
            blocks[event.index] = { type: 'tool_use', id: cb.id, name: cb.name, input: {}, _json: '' };
          break;
        }
        case 'content_block_delta': {
          const block = blocks[event.index];
          if (!block) break;
          if (event.delta.type === 'text_delta') {
            block.text += event.delta.text;
            onText?.(event.delta.text);
          } else if (event.delta.type === 'input_json_delta') {
            block._json += event.delta.partial_json;
          }
          break;
        }
        case 'content_block_stop': {
          const block = blocks[event.index];
          if (block?.type === 'tool_use') {
            block.input = block._json ? JSON.parse(block._json) : {};
            delete block._json;
          }
          break;
        }
        case 'message_delta':
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          break;
        case 'error':
          throw new Error(`Claude stream error: ${JSON.stringify(event.error)}`);
      }
    }
  }

  // Drop empty text blocks; the API rejects them in history
  const content = blocks.filter((b) => b && !(b.type === 'text' && !b.text.trim()));
  return { content, stopReason };
}
