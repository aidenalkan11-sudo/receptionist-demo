# AI Receptionist Demo

A minimal, multi-tenant AI phone receptionist: one server, one codebase, each
business is just a config file. Built for demoing to prospective clients —
not yet hardened for production call volume.

## How it works

1. Someone calls a Twilio number.
2. Twilio transcribes their speech and POSTs it to your server.
3. Your server sends the transcript + that business's system prompt to your
   freellmapi endpoint (OpenAI-compatible).
4. The reply is spoken back via Twilio's text-to-speech. This loops until the
   caller says goodbye or the model's reply signals the call is wrapping up.
5. When the call ends, Twilio calls a status webhook, which triggers a
   follow-up SMS (e.g. a booking link) via Twilio's Messaging API.

## Setup

```bash
npm install
npm start
```

Then open **http://localhost:3000/setup** in your browser. Fill in:
- Your business details (name, greeting, hours/FAQs, follow-up text)
- Your freellmapi URL, key, and model
- Your Twilio Account SID and Auth Token

Hit **Save configuration**. It writes to `tenants/<your-business>.json` and
`data/config.json` on your machine — nothing leaves your computer. Both
files are in `.gitignore` since they hold live credentials.

Your server needs a public URL for Twilio to reach it:
- **Local testing**: run `npx ngrok http 3000` in another terminal. The
  setup page auto-detects a running ngrok tunnel and shows you the exact
  webhook URLs to paste into Twilio, with a Copy button for each.
- **Real demo**: deploy to Render, Railway, Fly.io, or similar — anywhere
  that gives you a persistent public HTTPS URL. (Your freellmapi instance
  needs to be reachable from wherever this server runs too — if it's on
  `localhost`, both need to run on the same machine.)

## Configuring a Twilio number for a business

In the Twilio Console, open the phone number and set:

| Field | Value |
|---|---|
| **A call comes in** (Voice webhook) | `https://your-domain.com/voice/<tenant-id>` (HTTP POST) |
| **Call status changes** (separate field, same page) | `https://your-domain.com/voice/<tenant-id>/status` (HTTP POST) |

`<tenant-id>` matches a filename in `/tenants` (without `.json`) — e.g. for
`tenants/acme-dental.json`, use `/voice/acme-dental`.

## Ring the human first, AI as backup

Add `humanNumber` (and optionally `ringTimeoutSeconds`, default 18) to a
tenant's JSON file, and calls will ring that real phone first. If it's
answered, the call just happens normally and the AI never gets involved. If
it rings out, is busy, or fails, Twilio automatically hands the call to the
AI receptionist — same flow as before, no separate setup needed.

Leave `humanNumber` out of the config (see `example-salon.json`) and calls go
straight to the AI, no ringing first.

## Adding a new business (duplicating the agent)

1. Copy `tenants/acme-dental.json` to `tenants/<new-business>.json`.
2. Edit `businessName`, `greeting`, `systemPrompt` (their hours, services,
   FAQs, tone), `followUpSms`, and `twilioNumber`.
3. Buy or reassign a Twilio number, point its two webhooks at
   `/voice/<new-business>` and `/voice/<new-business>/status`.
4. Done — no code changes, no redeploy needed (unless your host requires a
   restart to pick up new files).

## Known limitations (demo-grade, not production-grade)

- **Turn-taking is call-and-response**, not real-time streaming — there's a
  beat of silence while the model thinks. Fine for a demo; for a production
  pitch, look at Twilio Media Streams + a low-latency STT/TTS pipeline, or a
  hosted voice-AI layer (Vapi, Retell) sitting in front of the same LLM call.
- **Conversation state is in-memory** — restarting the server drops any calls
  in progress. Move to Redis or a DB before running this for real.
- **freellmapi is a free-tier aggregator meant for personal experimentation**,
  per its own docs — great for building this for $0, but rate limits or a
  provider outage mid-call would look bad in front of a prospect. Swap in a
  paid API key (Claude, OpenAI, etc.) before any demo that actually matters,
  or at least test the specific free-tier model you're using isn't flaky.
- **No booking/calendar integration yet** — the follow-up SMS currently
  points to a static booking link. Wiring `book_appointment` up to Google
  Calendar or Cal.com's API is the natural next step once a business wants
  more than a demo.
- **No inbound SMS handling yet** — this covers voice + outbound follow-up
  text. Two-way SMS conversations would reuse the same `askLLM()` function
  behind a new `/sms/:tenantId` webhook.
