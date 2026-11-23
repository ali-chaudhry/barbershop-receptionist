// Text-only test mode: type as the caller, see replies and tool calls.
// No phone call, and texts are NOT sent (they're printed) unless you add --live.
//
//   npm run test-call
//   npm run test-call -- --from +16475551234     pretend to call from this number
//   npm run test-call -- --live                  actually send the texts (costs money)
import readline from 'node:readline/promises';
import { CallAgent } from './src/agent.js';

const args = process.argv.slice(2);
const live = args.includes('--live');
const fromIdx = args.indexOf('--from');
const from = fromIdx !== -1 ? args[fromIdx + 1] : '+19055550123';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

const agent = new CallAgent({
  callSid: 'TEST-' + Date.now(),
  callerNumber: from,
  dryRun: !live,
  onToolCall: (name, input) => console.log(`\n   🔧 tool: ${name} ${JSON.stringify(input)}`),
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`\nTest call from ${from}${live ? ' (LIVE: texts will really send)' : ' (texts are only printed)'}. Type "quit" to stop.\n`);
console.log("Agent: Hi, thanks for calling Executive Styles! I'm the shop's AI assistant. How can I help you?\n");

while (true) {
  const said = (await rl.question('You: ')).trim();
  if (!said) continue;
  if (said.toLowerCase() === 'quit') break;
  process.stdout.write('Agent: ');
  try {
    await agent.handleUserTurn(said, { onText: (t) => process.stdout.write(t) });
  } catch (err) {
    console.error('\n[error]', err.message);
  }
  process.stdout.write('\n\n');
  if (agent.endRequest) {
    console.log(
      agent.endRequest.reasonCode === 'transfer'
        ? `[Call would now transfer to Nazeef at ${process.env.OWNER_PHONE_NUMBER}]`
        : '[Call ended]',
    );
    break;
  }
}
rl.close();
