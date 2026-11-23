# Executive Styles Hair Studio: AI Receptionist

Twilio answers the phone, and Claude does the thinking. The agent:

- answers questions about hours, prices, location, parking, walk-ins, payment and cancellations
- texts callers the Booksy link (a specific barber's link, or the shop link)
- logs booking requests
- texts Nazeef callback requests
- transfers the live call to Nazeef, but only when the caller insists AND has a real reason

This covers Parts 1–3 of the build guide (Prompts 1–6). It is already built, so skip the "clone the demo" step.

## What's in here

| File | What it does |
|---|---|
| `server.js` | The server Twilio talks to (webhooks + live WebSocket) |
| `src/agent.js` | Runs one call: conversation history, Claude, tools |
| `src/claude.js` | Streams replies from Claude so the caller hears them fast |
| `src/tools.js` | The 5 tools: send_booking_link, log_request, request_callback, transfer_to_owner, end_call |
| `src/twilio.js` | Sends texts; checks that requests really come from Twilio |
| `src/prompt.js` | Builds the system prompt from the 3 data files |
| `data/guideline.md` | **How the agent behaves.** Edit this to change its behaviour |
| `data/shop-info.md` | **The facts it's allowed to say.** Edit when prices or hours change |
| `data/barbers.json` | Barber names + their personal Booksy links |
| `test-mode.js` | Type as a caller in the terminal. No phone call, texts are printed instead of sent |
| `logs/` | Created automatically: calls (with full transcripts), requests, callbacks, transfers |

Edits to the `data/` files apply on the next call, with no restart.

## Setup (first time)

1. Do **Part 1** of the guide: Node.js 24, ngrok, an Anthropic API key, and a Twilio Canadian 905 number with Voice + SMS. Accept Twilio's AI terms and upgrade the Twilio account.
2. Put this folder on your laptop, open a terminal in it, and run:
   ```
   npm install
   ```
3. Copy `.env.example` to a new file called `.env` and fill in the keys. Nazeef's number is already filled in.

## Test without a phone call (free)

```
npm run test-call
```
Type like a caller. Tool calls show up as 🔧 lines, and texts are printed instead of sent. Add `-- --live` to really send the texts.

## First real call (Part 3A of the guide)

1. In a second terminal, run `ngrok http 8080`. Copy the address WITHOUT `https://` into `PUBLIC_HOST` in `.env`.
2. Run `npm start`.
3. In the Twilio Console, open your number. Under Voice Configuration, set **A call comes in** to Webhook `https://YOUR-NGROK-ADDRESS/twiml` (HTTP POST). Save.
4. Call the number.

On free ngrok, the address changes every restart, so redo steps 1 and 3 each session.

## Choosing a voice

Set `TTS_PROVIDER` and `VOICE` in `.env` (for example ElevenLabs plus a voice ID), then restart. Twilio's ConversationRelay docs list the available voices. Try a few with Nazeef.

## Still to do

- [ ] **Barber Booksy links:** add each barber's personal Booksy link in `data/barbers.json`. Until then, everyone gets the shop link with "pick Randy" (or whichever barber) in the text.
- [ ] Pick a voice.
- [ ] Run the guide's test checklist (30 typed tests, then 20 real calls on different carriers).
- [ ] Part 4: deploy to Render (paid plan that doesn't sleep), Google Calendar instead of the log file, the 9 AM summary text, and a private GitHub backup.
- [ ] Don't forward the shop's real line until Nazeef signs off.

## Troubleshooting

| Problem | Fix |
|---|---|
| "An application error has occurred" | Server not running, the webhook address is wrong, or `PUBLIC_HOST` doesn't match the ngrok address. The terminal shows "❌ Rejected" if the signature check failed |
| Worked yesterday, not today | The ngrok address changed. Update `.env` and Twilio |
| Text never arrives | The number needs SMS, the account must be upgraded. Check the Twilio Console messaging logs |
| Says something wrong | Fix `data/shop-info.md` or add a rule to `data/guideline.md` |
| Transfer doesn't ring Nazeef | Check `OWNER_PHONE_NUMBER` is `+16476140692` and the account is upgraded |
