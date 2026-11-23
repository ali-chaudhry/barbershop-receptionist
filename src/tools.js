// The tools Claude can use during a call.
import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadBarbers } from './prompt.js';
import { sendSms } from './twilio.js';

const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const MAX_TEXTS_PER_CALL = 3;

export const toolDefinitions = [
  {
    name: 'send_booking_link',
    description:
      "Text the caller a Booksy booking link at the number they're calling from. Pass barber_name for a specific barber's link; leave it out to send the shop's main Booksy link. Only call this after the caller has said yes to getting a text.",
    input_schema: {
      type: 'object',
      properties: {
        barber_name: { type: 'string', description: 'Barber the caller wants, if any' },
      },
    },
  },
  {
    name: 'log_request',
    description:
      'Save a booking request for the shop to review. Call after sending a booking link, with whatever details the caller gave.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Caller's name" },
        barber: { type: 'string' },
        service: { type: 'string' },
        day: { type: 'string', description: 'Preferred day/time, in their words' },
      },
    },
  },
  {
    name: 'request_callback',
    description:
      "Text Nazeef (the owner) a message asking him to call this caller back. Use for complaints, business inquiries, questions you can't answer, or anyone wanting a callback.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Caller's name" },
        reason: { type: 'string', description: 'Short reason for the callback' },
      },
      required: ['name', 'reason'],
    },
  },
  {
    name: 'transfer_to_owner',
    description:
      'Put the live call through to Nazeef. ONLY when the caller insists on a person AND has a real reason you cannot handle (never for prices, hours, booking, etc). Say you are putting them through in the same reply, before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why they need Nazeef' },
        caller_name: { type: 'string' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'end_call',
    description: 'Hang up. Say goodbye in the same reply before calling this.',
    input_schema: { type: 'object', properties: {} },
  },
];

function writeLog(file, entry) {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(path.join(LOG_DIR, file), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Finds a barber by name, tolerating speech-to-text misspellings. */
export function findBarber(name) {
  if (!name) return null;
  const wanted = name.trim().toLowerCase();
  const { barbers } = loadBarbers();
  let best = null;
  let bestDist = Infinity;
  for (const b of barbers) {
    for (const n of [b.name, ...(b.aliases || [])]) {
      const d = levenshtein(wanted, n.toLowerCase());
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
  }
  return bestDist <= 2 ? best : null;
}

async function text(ctx, to, body) {
  if (ctx.dryRun) {
    console.log(`\n   📱 [TEST MODE — text not sent] to ${to}:\n   ${body.replace(/\n/g, '\n   ')}\n`);
    return 'test';
  }
  return sendSms(to, body);
}

/**
 * Runs a tool. Returns a string result for Claude.
 * ctx: { callSid, callerNumber, dryRun, textsSent, requestEnd(handoffData|null) }
 */
export async function runTool(name, input, ctx) {
  const owner = process.env.OWNER_PHONE_NUMBER;
  const caller = ctx.callerNumber || 'unknown number';
  writeLog('tool-calls.jsonl', { callSid: ctx.callSid, caller: ctx.callerNumber, tool: name, input });

  switch (name) {
    case 'send_booking_link': {
      if (!ctx.callerNumber || !/^\+1\d{10}$/.test(ctx.callerNumber))
        return "Can't text: the caller's number is hidden or not a North American cell. Tell them to book on Booksy by searching Executive Styles Hair Studio, or check the shop's Instagram.";
      if (ctx.textsSent >= MAX_TEXTS_PER_CALL) return 'Text limit for this call reached. Do not send more texts.';
      const { shopBooksyLink } = loadBarbers();
      let link = shopBooksyLink;
      let who = 'the shop';
      let note = '';
      if (input.barber_name) {
        const barber = findBarber(input.barber_name);
        if (!barber) {
          note = ` No barber called "${input.barber_name}" was found, so the shop link was sent instead. Mention they can pick any barber there.`;
        } else if (barber.booksyLink) {
          link = barber.booksyLink;
          who = barber.name;
        } else {
          who = barber.name;
          note = ` ${barber.name} doesn't have a personal link set up yet, so the shop link was sent; they can pick ${barber.name} on it.`;
        }
      }
      let intro = 'book here';
      if (who !== 'the shop') intro = link === shopBooksyLink ? `book here (pick ${who})` : `book with ${who} here`;
      const body = `Executive Styles Hair Studio — ${intro}: ${link}\n9699 Jane St, Unit 12A, Vaughan. Open daily 11am–10pm.`;
      try {
        await text(ctx, ctx.callerNumber, body);
        ctx.textsSent++;
        return `Text sent to the caller.${note}`;
      } catch (err) {
        console.error(err);
        return 'The text failed to send. Apologize and tell them they can book on Booksy by searching Executive Styles Hair Studio.';
      }
    }

    case 'log_request': {
      writeLog('requests.jsonl', { callSid: ctx.callSid, phone: ctx.callerNumber, ...input });
      return 'Request saved.';
    }

    case 'request_callback': {
      const body = `📞 Callback request (AI receptionist)\nName: ${input.name}\nNumber: ${caller}\nReason: ${input.reason}`;
      writeLog('callbacks.jsonl', { callSid: ctx.callSid, phone: ctx.callerNumber, ...input });
      try {
        await text(ctx, owner, body);
        return 'Message sent to Nazeef. Tell the caller he will get back to them.';
      } catch (err) {
        console.error(err);
        return "Message saved, but the text to Nazeef failed. Tell the caller you've noted it and the shop will get back to them.";
      }
    }

    case 'transfer_to_owner': {
      writeLog('transfers.jsonl', { callSid: ctx.callSid, phone: ctx.callerNumber, ...input });
      // Heads-up text so Nazeef knows who's calling and why (also his record if he misses it)
      const body = `🔀 Transferring a call to you (AI receptionist)\nName: ${input.caller_name || 'not given'}\nNumber: ${caller}\nReason: ${input.reason}`;
      try {
        await text(ctx, owner, body);
      } catch (err) {
        console.error(err);
      }
      ctx.requestEnd({ reasonCode: 'transfer', reason: input.reason });
      return 'Transferring now.';
    }

    case 'end_call': {
      ctx.requestEnd({ reasonCode: 'end_call' });
      return 'Ending call.';
    }

    default:
      return `Unknown tool ${name}`;
  }
}
