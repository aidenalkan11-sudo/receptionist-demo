require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------- Global config (freellmapi + Twilio account) ----------
// Stored in data/config.json instead of .env so the setup page can write to
// it and changes apply immediately, no restart needed. Keep this file out
// of git — it holds live credentials.
const configPath = path.join(__dirname, 'data', 'config.json');

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    return { freellmApiUrl: '', freellmApiKey: '', freellmModel: '', twilioAccountSid: '', twilioAuthToken: '' };
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function getTwilioClient() {
  const config = loadConfig();
  if (!config.twilioAccountSid || !config.twilioAuthToken) return null;
  return twilio(config.twilioAccountSid, config.twilioAuthToken);
}

// ---------- Tenant config ----------
// Each business = one JSON file in /tenants. The setup page writes these;
// you can also hand-edit or duplicate them directly.
const tenantsDir = path.join(__dirname, 'tenants');
fs.mkdirSync(tenantsDir, { recursive: true });

function loadTenant(tenantId) {
  const file = path.join(tenantsDir, `${tenantId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveTenant(tenant) {
  const file = path.join(tenantsDir, `${tenant.id}.json`);
  fs.writeFileSync(file, JSON.stringify(tenant, null, 2));
}

function listTenants() {
  return fs
    .readdirSync(tenantsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(tenantsDir, f), 'utf8')));
}

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ---------- Conversation state ----------
// In-memory, keyed by Twilio CallSid. Fine for a demo; swap for Redis/DB
// if you need calls to survive a server restart.
const conversations = new Map();

// ---------- LLM call ----------
async function askLLM(tenant, history) {
  const config = loadConfig();
  const messages = [{ role: 'system', content: tenant.systemPrompt }, ...history];

  try {
    const res = await fetch(config.freellmApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.freellmApiKey ? { Authorization: `Bearer ${config.freellmApiKey}` } : {})
      },
      body: JSON.stringify({
        model: tenant.model || config.freellmModel || 'gpt-4o-mini',
        messages,
        temperature: 0.4,
        max_tokens: 200
      })
    });

    if (!res.ok) {
      console.error('LLM error', res.status, await res.text());
      return "Sorry, I'm having a little trouble connecting right now. Could you say that again, or would you like to leave a message for the team?";
    }

    const data = await res.json();
    return (
      data.choices?.[0]?.message?.content?.trim() ||
      "Sorry, could you say that again?"
    );
  } catch (err) {
    console.error('LLM request failed', err);
    return "Sorry, I'm having trouble right now — would you like to leave a message and we'll call you back?";
  }
}

// Builds the "AI answers" TwiML: greeting + listen for speech.
// Shared by the direct-to-AI path and the ring-no-answer fallback path.
function startAiConversation(tenant, callSid, twiml) {
  conversations.set(callSid, []);

  const gather = twiml.gather({
    input: 'speech',
    action: `/voice/${tenant.id}/respond`,
    speechTimeout: 'auto',
    method: 'POST'
  });
  gather.say(tenant.greeting);

  // Falls through here only if Twilio never got speech input
  twiml.say("I didn't catch that. Please call back anytime. Goodbye!");
}

// ---------- Incoming call ----------
app.post('/voice/:tenantId', (req, res) => {
  const tenant = loadTenant(req.params.tenantId);
  const twiml = new VoiceResponse();

  if (!tenant) {
    twiml.say('Sorry, this line is not configured yet.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // If this tenant has a human number configured, ring it first.
  // If nobody answers within ringTimeoutSeconds (or it's busy/fails),
  // Twilio calls /voice/:tenantId/dial-result and the AI takes over.
  if (tenant.humanNumber) {
    const dial = twiml.dial({
      timeout: tenant.ringTimeoutSeconds || 18,
      action: `/voice/${tenant.id}/dial-result`,
      method: 'POST'
    });
    dial.number(tenant.humanNumber);
  } else {
    startAiConversation(tenant, req.body.CallSid, twiml);
  }

  res.type('text/xml').send(twiml.toString());
});

// ---------- Result of ringing the human ----------
// Twilio hits this after the <Dial> above ends, whether or not it was answered.
app.post('/voice/:tenantId/dial-result', (req, res) => {
  const tenant = loadTenant(req.params.tenantId);
  const twiml = new VoiceResponse();
  const dialStatus = req.body.DialCallStatus; // completed | no-answer | busy | failed | canceled

  if (!tenant) {
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  if (dialStatus === 'completed') {
    // A human answered and the call already happened — nothing more to do.
    twiml.hangup();
  } else {
    // No answer / busy / failed -> hand off to the AI receptionist.
    startAiConversation(tenant, req.body.CallSid, twiml);
  }

  res.type('text/xml').send(twiml.toString());
});

// ---------- Each conversation turn ----------
app.post('/voice/:tenantId/respond', async (req, res) => {
  const tenant = loadTenant(req.params.tenantId);
  const twiml = new VoiceResponse();
  const callSid = req.body.CallSid;
  const speech = req.body.SpeechResult || '';

  if (!tenant) {
    twiml.say('Sorry, something went wrong.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const history = conversations.get(callSid) || [];
  history.push({ role: 'user', content: speech });

  const reply = await askLLM(tenant, history);
  history.push({ role: 'assistant', content: reply });
  conversations.set(callSid, history);

  const endingCall = /\b(goodbye|have a great day|bye for now|take care)\b/i.test(reply);

  if (endingCall) {
    twiml.say(reply);
    twiml.hangup();
  } else {
    const gather = twiml.gather({
      input: 'speech',
      action: `/voice/${tenant.id}/respond`,
      speechTimeout: 'auto',
      method: 'POST'
    });
    gather.say(reply);
    twiml.say('Still there? Feel free to ask anything else, or say goodbye to end the call.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ---------- Call ended -> follow-up SMS ----------
// Point this Twilio number's "Call status changes" webhook (in the Twilio
// console, separate from the Voice webhook) at /voice/<tenantId>/status
app.post('/voice/:tenantId/status', async (req, res) => {
  const tenant = loadTenant(req.params.tenantId);
  const twilioClient = getTwilioClient();
  const callStatus = req.body.CallStatus;
  const caller = req.body.From;

  if (tenant && twilioClient && callStatus === 'completed' && tenant.followUpSms && caller) {
    try {
      await twilioClient.messages.create({
        to: caller,
        from: tenant.twilioNumber,
        body: tenant.followUpSms
      });
      console.log(`Follow-up SMS sent to ${caller} for ${tenant.id}`);
    } catch (e) {
      console.error('SMS follow-up failed', e.message);
    }
  }

  conversations.delete(req.body.CallSid);
  res.sendStatus(200);
});

app.get('/', (req, res) => res.send('AI receptionist is running. Visit /setup to configure it.'));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));

// ---------- Setup page API ----------
// GET current config + tenants, so the setup page can prefill the form.
app.get('/setup/data', (req, res) => {
  const config = loadConfig();
  res.json({
    config: { ...config, twilioAuthToken: config.twilioAuthToken ? '••••••••' : '' },
    tenants: listTenants()
  });
});

// Save both the global API/Twilio config and one business's tenant file.
app.post('/setup/save', (req, res) => {
  const { config, tenant } = req.body;

  if (config) {
    const existing = loadConfig();
    // Keep the real stored auth token if the form sent back the masked placeholder
    const merged = { ...existing, ...config };
    if (config.twilioAuthToken === '••••••••') merged.twilioAuthToken = existing.twilioAuthToken;
    saveConfig(merged);
  }

  let savedTenant = null;
  if (tenant && tenant.businessName) {
    const id = tenant.id || slugify(tenant.businessName);
    savedTenant = { ...tenant, id };
    saveTenant(savedTenant);
  }

  res.json({ ok: true, tenant: savedTenant });
});

// Best-effort: if ngrok is running locally, grab its public URL from
// ngrok's own local inspector API so the setup page can show ready-to-paste
// webhook links instead of you hunting for the URL yourself.
app.get('/setup/ngrok-url', async (req, res) => {
  try {
    const r = await fetch('http://localhost:4040/api/tunnels');
    const data = await r.json();
    const httpsTunnel = data.tunnels?.find((t) => t.proto === 'https');
    res.json({ url: httpsTunnel ? httpsTunnel.public_url : null });
  } catch (e) {
    res.json({ url: null });
  }
});

app.listen(PORT, () => {
  console.log(`AI receptionist listening on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}/setup to configure your business, API, and Twilio info.`);
});
