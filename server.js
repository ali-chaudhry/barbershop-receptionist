// The server Twilio talks to.
//   POST /twiml           Twilio calls this when the number rings -> starts ConversationRelay
//   WS   /ws              live conversation (Twilio sends caller speech as text, we send replies)
//   POST /connect-action  after the AI session ends -> hang up, or transfer to Nazeef
//   POST /transfer-status after the transfer attempt -> apology if Nazeef didn't pick up
import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { CallAgent } from './src/agent.js';
import { isValidTwilioRequest } from './src/twilio.js';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.PUBLIC_HOST;
const OWNER = process.env.OWNER_PHONE_NUMBER;

const WELCOME = "Hi, thanks for calling Executive Styles! I'm the shop's AI assistant. How can I help you?";

for (const key of ['ANTHROPIC_API_KEY', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'OWNER_PHONE_NUMBER', 'PUBLIC_HOST']) {
  if (!process.env[key]) console.warn(`⚠️  ${key} is missing from .env`);
}

const xml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

function twiml(res, inner) {
  res.writeHead(200, { 'content-type': 'text/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`);
}

async function readForm(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return Object.fromEntries(new URLSearchParams(body));
}

function logCall(entry) {
  mkdirSync('logs', { recursive: true });
  appendFileSync('logs/calls.jsonl', JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// ---------- HTTP routes ----------
const server = http.createServer(async (req, res) => {
  const route = req.url.split('?')[0];

  if (req.method === 'GET' && route === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Executive Styles receptionist is running.');
  }

  if (req.method !== 'POST') {
    res.writeHead(404);
    return res.end();
  }

  const params = await readForm(req);
  if (!isValidTwilioRequest(`https://${HOST}${req.url}`, params, req.headers['x-twilio-signature'])) {
    console.warn(`❌ Rejected ${route}: signature didn't match. Check PUBLIC_HOST and TWILIO_AUTH_TOKEN in .env.`);
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (route === '/twiml') {
    const voiceAttrs = [
      process.env.TTS_PROVIDER ? `ttsProvider="${xml(process.env.TTS_PROVIDER)}"` : '',
      process.env.VOICE ? `voice="${xml(process.env.VOICE)}"` : '',
    ].join(' ');
    return twiml(
      res,
      `<Connect action="https://${HOST}/connect-action">` +
        `<ConversationRelay url="wss://${HOST}/ws" welcomeGreeting="${xml(WELCOME)}" language="en-US" ${voiceAttrs} />` +
        `</Connect>`,
    );
  }

  if (route === '/connect-action') {
    let handoff = null;
    try {
      handoff = params.HandoffData ? JSON.parse(params.HandoffData) : null;
    } catch {}
    if (handoff?.reasonCode === 'transfer') {
      return twiml(res, `<Dial timeout="20" action="https://${HOST}/transfer-status">${xml(OWNER)}</Dial>`);
    }
    if (handoff?.reasonCode === 'end_call') return twiml(res, '<Hangup/>');
    // Session ended unexpectedly (crash, network, etc.)
    return twiml(
      res,
      `<Say>Sorry, we're having some technical trouble. You can book anytime on Booksy, or call back in a few minutes. Bye!</Say><Hangup/>`,
    );
  }

  if (route === '/transfer-status') {
    if (params.DialCallStatus === 'completed') return twiml(res, '<Hangup/>');
    return twiml(
      res,
      `<Say>Sorry, Nazeef couldn't pick up right now. I've sent him your number and he'll call you back as soon as he can. Bye!</Say><Hangup/>`,
    );
  }

  res.writeHead(404);
  res.end();
});

// ---------- WebSocket: the live conversation ----------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url.split('?')[0] !== '/ws' || !isValidTwilioRequest(`wss://${HOST}${req.url}`, {}, req.headers['x-twilio-signature'])) {
    console.warn('❌ Rejected WebSocket connection (wrong path or signature).');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => handleCall(ws));
});

function handleCall(ws) {
  let agent = null;
  let callInfo = {};
  let current = null; // { controller, promise } for the reply in progress
  let ended = false;

  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  async function cancelCurrent() {
    if (!current) return;
    current.controller.abort();
    await current.promise.catch(() => {});
    current = null;
  }

  async function respond(text) {
    await cancelCurrent();
    const controller = new AbortController();
    const promise = (async () => {
      try {
        const spoken = await agent.handleUserTurn(text, {
          signal: controller.signal,
          onText: (token) => send({ type: 'text', token, last: false }),
        });
        if (controller.signal.aborted) return;
        send({ type: 'text', token: '', last: true });

        if (agent.endRequest && !ended) {
          ended = true;
          // Give the goodbye time to be spoken before ending the session
          const wait = Math.min(10000, 1500 + spoken.length * 65);
          setTimeout(() => send({ type: 'end', handoffData: JSON.stringify(agent.endRequest) }), wait);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('Reply failed:', err);
        send({
          type: 'text',
          token: "Sorry, I'm having a bit of trouble right now. You can book anytime on Booksy, or call back in a few minutes.",
          last: true,
        });
      }
    })();
    current = { controller, promise };
    await promise;
    if (current?.controller === controller) current = null;
  }

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'setup':
        callInfo = { callSid: msg.callSid, from: msg.from, to: msg.to };
        agent = new CallAgent({
          callSid: msg.callSid,
          callerNumber: msg.from,
          onToolCall: (name, input) => console.log(`   🔧 ${name}`, JSON.stringify(input)),
        });
        console.log(`📞 Call started from ${msg.from} (${msg.callSid})`);
        logCall({ event: 'start', ...callInfo });
        break;

      case 'prompt':
        if (!agent || ended) return;
        console.log(`   🗣️  Caller: ${msg.voicePrompt}`);
        respond(msg.voicePrompt);
        break;

      case 'interrupt':
        console.log(`   ✋ Interrupted after: "${msg.utteranceUntilInterrupt}"`);
        await cancelCurrent();
        agent?.noteInterruption(msg.utteranceUntilInterrupt);
        break;

      case 'error':
        console.error('Twilio ConversationRelay error:', msg.description);
        break;
    }
  });

  ws.on('close', () => {
    current?.controller.abort();
    if (agent) {
      console.log(`📴 Call ended (${callInfo.callSid})`);
      logCall({ event: 'end', ...callInfo, outcome: agent.endRequest?.reasonCode || 'caller_hung_up', transcript: agent.messages });
    }
  });
}

server.listen(PORT, () => {
  console.log(`✅ Receptionist server running on port ${PORT}`);
  console.log(`   Twilio webhook ("A call comes in"): https://${HOST || 'YOUR-PUBLIC-HOST'}/twiml`);
});
