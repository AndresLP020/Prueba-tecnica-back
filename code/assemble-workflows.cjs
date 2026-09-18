const fs = require("fs");
const path = require("path");

const root = __dirname;
const score = fs.readFileSync(path.join(root, "score.js"), "utf8");
const normalize = fs.readFileSync(path.join(root, "normalize.js"), "utf8");
const emailTemplates = fs.readFileSync(path.join(root, "emailTemplates.js"), "utf8");
const aiPrompt = fs.readFileSync(path.join(root, "aiPrompt.txt"), "utf8");

function node(partial) {
  return Object.assign(
    {
      typeVersion: 1,
      position: [0, 0],
      id: partial.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    },
    partial,
  );
}

function conn(from, to) {
  return {
    [from]: { main: [[{ node: to, type: "main", index: 0 }]] },
  };
}

function mergeConns(list) {
  const out = {};
  for (const c of list) {
    const key = Object.keys(c)[0];
    if (!out[key]) out[key] = c[key];
    else out[key].main[0].push(...c[key].main[0]);
  }
  return out;
}

const prepareOutputs = `
const item = $input.first().json;
const spam = Boolean(item.flags && item.flags.spam);
const duplicate = Boolean(item.duplicate);
item.status = spam ? "spam" : duplicate ? item.status || "active" : "active";
item.webhookResponse = {
  leadId: item.leadId,
  tier: item.tier,
  bookingUrl: spam ? null : item.bookingUrl || null,
  duplicate: duplicate,
  status: item.status,
};
item.skipConfirmation = spam || duplicate || Boolean(item.flags && item.flags.confirmationSent);
item.skipSlack = Boolean(item.flags && item.flags.slackSent);
item.needsBrief = !spam && (item.tier === "A" || item.tier === "B") && !Boolean(item.flags && item.flags.briefCreated);
item.needsCalendar = !spam && item.tier === "A" && !Boolean(item.flags && item.flags.calendarEventCreated);
item.slackPayload = {
  text: (duplicate ? "Reenvío" : spam ? "Lead spam" : "Nuevo lead") + " · " + (item.fullName || ""),
  blocks: [
    { type: "header", text: { type: "plain_text", text: (spam ? "Alerta silenciosa" : duplicate ? "Reenvío" : item.tier === "A" ? "ÓRBITA A — prioridad" : "Nuevo lead " + item.tier) } },
    { type: "section", fields: [
      { type: "mrkdwn", text: "*Nombre*\\n" + (item.fullName || "") },
      { type: "mrkdwn", text: "*Empresa*\\n" + (item.company || "") },
      { type: "mrkdwn", text: "*Score*\\n" + String(item.score) },
      { type: "mrkdwn", text: "*Tier*\\n" + item.tier },
      { type: "mrkdwn", text: "*Correo*\\n" + (item.emailNormalized || "") },
      { type: "mrkdwn", text: "*Tel*\\n" + (item.phoneE164 || "") }
    ]},
    { type: "context", elements: [{ type: "mrkdwn", text: "nicho " + (item.niche || "") + " · " + (item.need || "") + (item.bookingUrl ? " · <" + item.bookingUrl + "|agenda>" : "") }] }
  ]
};
return [{ json: item }];
`;

const parseAi = `
const item = $input.first().json;
let ai = { summary: (item.company || "Prospecto") + " busca apoyo en " + (item.need || "su proyecto") + ".", intent: "evaluando", spamRisk: 0, intro: "Recibimos tu señal. Ya estamos trazando la aproximación." };
try {
  const raw = $input.first().json.aiRaw || $input.first().json.body || $input.first().json;
  let text = "";
  if (typeof raw === "string") text = raw;
  else if (raw && raw.candidates && raw.candidates[0] && raw.candidates[0].content) {
    text = raw.candidates[0].content.parts.map(function(p){return p.text}).join("\\n");
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) ai = Object.assign(ai, JSON.parse(text.slice(start, end + 1)));
} catch (e) {}
item.ai = ai;
item.aiIntro = ai.intro;
item.spamRisk = typeof ai.spamRisk === "number" ? ai.spamRisk : 0;
if (item.spamRisk >= 0.7) {
  item.flags = Object.assign({}, item.flags, { spam: true });
  item.tier = "C";
  item.bookingUrl = null;
  item.status = "spam";
}
item.flags = Object.assign({}, item.flags, { aiDone: true });
return [{ json: item }];
`;

const nextBusinessHour = `
const item = $input.first().json;
function nextSlot(now) {
  const tz = "America/Mexico_City";
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  let d = new Date(now.getTime() + 60 * 60 * 1000);
  for (let i = 0; i < 96; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(d).map(function(p){ return [p.type, p.value]; }));
    const wd = parts.weekday;
    const hour = Number(parts.hour);
    const weekend = wd === "Sat" || wd === "Sun";
    if (!weekend && hour >= 9 && hour < 18) return d;
    d = new Date(d.getTime() + 30 * 60 * 1000);
  }
  return d;
}
const start = nextSlot(new Date());
const end = new Date(start.getTime() + 30 * 60 * 1000);
item.calendarStart = start.toISOString();
item.calendarEnd = end.toISOString();
item.calendarSummary = "Llamar lead A · " + (item.fullName || "") + " · " + (item.company || "");
return [{ json: item }];
`;

const logDoc = `
const item = $input.first().json;
const mask = function(email) {
  const p = String(email||"").split("@");
  if (p.length < 2) return "***";
  return p[0].slice(0,1) + "***@" + p[1];
};
return [{ json: {
  ts: new Date(),
  level: item.flags && item.flags.spam ? "warn" : "info",
  leadId: item.leadId,
  submissionId: item.submissionId,
  executionId: $execution && $execution.id ? String($execution.id) : "",
  step: item.logStep || "lead-intake",
  status: item.logStatus || "ok",
  message: item.logMessage || ("tier " + item.tier + " score " + item.score + " email " + mask(item.emailNormalized)),
} }];
`;

const mergeEmailCheck = `
const item = $input.first().json;
let check = item.emailCheck || item;
if (item.body) check = item.body;
item.enrichment = Object.assign({}, item.enrichment || {}, { emailCheck: check });
item.flags = Object.assign({}, item.flags || {}, { emailValidated: true });
if (check && (check.disposable === true || (check.is_disposable_email && check.is_disposable_email.value === true))) {
  item.enrichment.emailCheck = check;
}
return [{ json: item }];
`;

const duplicateUpdate = `
const item = $input.first().json;
const existing = item.existing || item;
item.duplicate = true;
item.leadId = existing.leadId || item.leadId;
item.tier = existing.tier || item.tier;
item.score = existing.score || item.score;
item.bookingUrl = existing.bookingUrl || item.bookingUrl;
item.submissionsCount = (existing.submissionsCount || 1) + 1;
item.status = existing.status || "active";
item.flags = Object.assign({}, existing.flags || {}, item.flags || {});
item.history = (existing.history || []).concat([{ ts: new Date().toISOString(), event: "resubmit", submissionId: item.submissionId }]);
return [{ json: item }];
`;

function workflow(name, id, nodes, connections, extraSettings) {
  return {
    name,
    id,
    active: false,
    isArchived: false,
    nodes,
    connections,
    settings: Object.assign(
      {
        executionOrder: "v1",
        timezone: "America/Mexico_City",
        callerPolicy: "workflowsFromSameOwner",
      },
      extraSettings || {},
    ),
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

const leadIntake = workflow(
  "lead-intake",
  "wf_lead_intake",
  [
    node({
      name: "Webhook",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2.1,
      position: [0, 300],
      webhookId: "lead-intake",
      parameters: {
        httpMethod: "POST",
        path: "lead-intake",
        authentication: "headerAuth",
        responseMode: "responseNode",
        options: {},
      },
      credentials: {
        httpHeaderAuth: { id: "CRED_HEADER_AUTH", name: "Lead Intake Header Auth" },
      },
    }),
    node({
      name: "Normalize lead",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [220, 300],
      parameters: { jsCode: normalize },
    }),
    node({
      name: "Find existing",
      type: "n8n-nodes-base.mongoDb",
      typeVersion: 1.2,
      position: [440, 300],
      parameters: {
        operation: "find",
        collection: "leads",
        options: { limit: 1 },
        query: '={ " $or": [ { "emailNormalized": "{{ $json.emailNormalized }}" }, { "submissionId": "{{ $json.submissionId }}" } ] }'.replace(" $or", "$or"),
      },
      credentials: { mongoDb: { id: "CRED_MONGO", name: "MongoDB leadflow" } },
    }),
    node({
      name: "Has duplicate?",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [660, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
          combinator: "and",
          conditions: [
            {
              id: "dup",
              leftValue: "={{ $json._id || $json.leadId }}",
              rightValue: "",
              operator: { type: "string", operation: "notEmpty" },
            },
          ],
        },
      },
    }),
    node({
      name: "Mark duplicate",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [880, 120],
      parameters: { jsCode: duplicateUpdate },
    }),
    node({
      name: "Validate email",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [880, 480],
      onError: "continueRegularOutput",
      retryOnFail: true,
      maxTries: 3,
      waitBetween: 2000,
      parameters: {
        method: "GET",
        url: "=https://emailvalidation.abstractapi.com/v1/?api_key={{ $env.ABSTRACT_API_KEY }}&email={{ $json.emailNormalized }}",
        options: { timeout: 8000 },
      },
    }),
    node({
      name: "Merge email check",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1100, 480],
      parameters: { jsCode: mergeEmailCheck },
    }),
    node({
      name: "Score lead",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1320, 480],
      parameters: { jsCode: score },
    }),
    node({
      name: "Ask LLM",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [1540, 480],
      onError: "continueRegularOutput",
      retryOnFail: true,
      maxTries: 3,
      waitBetween: 2000,
      parameters: {
        method: "POST",
        url: "={{ $env.LLM_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent' }}",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: "Content-Type", value: "application/json" },
            { name: "x-goog-api-key", value: "={{ $env.LLM_API_KEY }}" },
          ],
        },
        sendBody: true,
        specifyBody: "json",
        jsonBody: `={{ JSON.stringify({ contents: [{ parts: [{ text: ${JSON.stringify(aiPrompt)} .replace('{{firstName}}',$json.firstName||'').replace('{{company}}',$json.company||'').replace('{{niche}}',$json.niche||'').replace('{{need}}',$json.need||'').replace('{{budget}}',$json.budget||'').replace('{{urgency}}',$json.urgency||'').replace('{{message}}',String($json.message||'').slice(0,280)).replace('{{emailDomain}}', String($json.emailNormalized||'').split('@')[1] || '') }] }], generationConfig: { temperature: 0.2 } }) }}`,
        options: { timeout: 12000 },
      },
    }),
    node({
      name: "Parse AI",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1760, 480],
      parameters: { jsCode: parseAi.replace("$input.first().json.aiRaw || $input.first().json.body || $input.first().json", "$input.first().json") },
    }),
    node({
      name: "Score after AI spam",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [1980, 480],
      parameters: { jsCode: score },
    }),
    node({
      name: "Insert lead",
      type: "n8n-nodes-base.mongoDb",
      typeVersion: 1.2,
      position: [2200, 480],
      parameters: {
        operation: "insert",
        collection: "leads",
        fields:
          "leadId,submissionId,emailNormalized,fullName,phoneE164,company,niche,budget,urgency,need,message,consent,utm,score,tier,status,flags,bookingUrl,submissionsCount,history,enrichment,createdAt,updatedAt,timeZone,source,ai",
        options: {},
      },
      credentials: { mongoDb: { id: "CRED_MONGO", name: "MongoDB leadflow" } },
    }),
    node({
      name: "Prepare outputs",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [2420, 300],
      parameters: { jsCode: prepareOutputs },
    }),
    node({
      name: "Respond to Webhook",
      type: "n8n-nodes-base.respondToWebhook",
      typeVersion: 1.1,
      position: [2640, 300],
      parameters: {
        respondWith: "json",
        responseBody: "={{ JSON.stringify($json.webhookResponse) }}",
        options: {},
      },
    }),
    node({
      name: "Email templates",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [2860, 300],
      parameters: { jsCode: emailTemplates },
    }),
    node({
      name: "Skip confirmation?",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [3080, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
          combinator: "and",
          conditions: [
            {
              id: "skip",
              leftValue: "={{ $json.skipConfirmation }}",
              rightValue: true,
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
        },
      },
    }),
    node({
      name: "Gmail confirm",
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
      position: [3300, 480],
      retryOnFail: true,
      maxTries: 3,
      waitBetween: 2000,
      onError: "continueRegularOutput",
      parameters: {
        sendTo: "={{ $json.emailNormalized }}",
        subject: "={{ $json.emailSubject }}",
        emailType: "html",
        message: "={{ $json.emailHtml }}",
        options: { appendAttribution: false },
      },
      credentials: { gmailOAuth2: { id: "CRED_GMAIL", name: "Gmail ÓRBITA" } },
    }),
    node({
      name: "Slack notify",
      type: "n8n-nodes-base.httpRequest",
      typeVersion: 4.2,
      position: [3520, 300],
      retryOnFail: true,
      maxTries: 3,
      waitBetween: 2000,
      onError: "continueRegularOutput",
      parameters: {
        method: "POST",
        url: "={{ $env.SLACK_INCOMING_WEBHOOK }}",
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify($json.slackPayload) }}",
        options: {},
      },
    }),
    node({
      name: "Needs calendar?",
      type: "n8n-nodes-base.if",
      typeVersion: 2.2,
      position: [3740, 300],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
          combinator: "and",
          conditions: [
            {
              id: "cal",
              leftValue: "={{ $json.needsCalendar }}",
              rightValue: true,
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
        },
      },
    }),
    node({
      name: "Next business hour",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [3960, 180],
      parameters: { jsCode: nextBusinessHour },
    }),
    node({
      name: "Google Calendar",
      type: "n8n-nodes-base.googleCalendar",
      typeVersion: 1.3,
      position: [4180, 180],
      retryOnFail: true,
      maxTries: 3,
      waitBetween: 2000,
      onError: "continueRegularOutput",
      parameters: {
        calendar: { __rl: true, mode: "id", value: "={{ $env.CALENDAR_ID || 'primary' }}" },
        start: "={{ $json.calendarStart }}",
        end: "={{ $json.calendarEnd }}",
        additionalFields: {
          summary: "={{ $json.calendarSummary }}",
          description: "={{ 'Lead A ' + $json.leadId + ' ' + $json.emailNormalized }}",
          timeZone: { timezone: "America/Mexico_City" },
        },
      },
      credentials: { googleCalendarOAuth2Api: { id: "CRED_GCAL", name: "Google Calendar ÓRBITA" } },
    }),
    node({
      name: "Build log",
      type: "n8n-nodes-base.code",
      typeVersion: 2,
      position: [4400, 300],
      parameters: { jsCode: logDoc },
    }),
    node({
      name: "Insert log",
      type: "n8n-nodes-base.mongoDb",
      typeVersion: 1.2,
      position: [4620, 300],
      onError: "continueRegularOutput",
      parameters: {
        operation: "insert",
        collection: "logs",
        fields: "ts,level,leadId,submissionId,executionId,step,status,message",
        options: {},
      },
      credentials: { mongoDb: { id: "CRED_MONGO", name: "MongoDB leadflow" } },
    }),
  ],
  mergeConns([
    conn("Webhook", "Normalize lead"),
    conn("Normalize lead", "Find existing"),
    conn("Find existing", "Has duplicate?"),
    { "Has duplicate?": { main: [[{ node: "Mark duplicate", type: "main", index: 0 }], [{ node: "Validate email", type: "main", index: 0 }]] } },
    conn("Mark duplicate", "Prepare outputs"),
    conn("Validate email", "Merge email check"),
    conn("Merge email check", "Score lead"),
    conn("Score lead", "Ask LLM"),
    conn("Ask LLM", "Parse AI"),
    conn("Parse AI", "Score after AI spam"),
    conn("Score after AI spam", "Insert lead"),
    conn("Insert lead", "Prepare outputs"),
    conn("Prepare outputs", "Respond to Webhook"),
    conn("Respond to Webhook", "Email templates"),
    conn("Email templates", "Skip confirmation?"),
    { "Skip confirmation?": { main: [[{ node: "Slack notify", type: "main", index: 0 }], [{ node: "Gmail confirm", type: "main", index: 0 }]] } },
    conn("Gmail confirm", "Slack notify"),
    conn("Slack notify", "Needs calendar?"),
    { "Needs calendar?": { main: [[{ node: "Next business hour", type: "main", index: 0 }], [{ node: "Build log", type: "main", index: 0 }]] } },
    conn("Next business hour", "Google Calendar"),
    conn("Google Calendar", "Build log"),
    conn("Build log", "Insert log"),
  ]),
);

const errorHandler = workflow("error-handler", "wf_error_handler", [
  node({
    name: "Error Trigger",
    type: "n8n-nodes-base.errorTrigger",
    typeVersion: 1,
    position: [0, 300],
    parameters: {},
  }),
  node({
    name: "Format error",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [220, 300],
    parameters: {
      jsCode: `const e = $input.first().json;
const executionId = e.execution && e.execution.id ? e.execution.id : (e.id || "");
const msg = (e.execution && e.execution.error && e.execution.error.message) || e.message || "Error en workflow";
return [{ json: {
  ts: new Date(),
  level: "error",
  leadId: "",
  submissionId: "",
  executionId: String(executionId),
  step: "error-handler",
  status: "error",
  message: String(msg).slice(0, 500),
  slackPayload: { text: "n8n error " + executionId + " — " + String(msg).slice(0, 300) }
} }];`,
    },
  }),
  node({
    name: "Log error",
    type: "n8n-nodes-base.mongoDb",
    typeVersion: 1.2,
    position: [440, 180],
    onError: "continueRegularOutput",
    parameters: {
      operation: "insert",
      collection: "logs",
      fields: "ts,level,leadId,submissionId,executionId,step,status,message",
      options: {},
    },
    credentials: { mongoDb: { id: "CRED_MONGO", name: "MongoDB leadflow" } },
  }),
  node({
    name: "Slack error",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [440, 420],
    onError: "continueRegularOutput",
    retryOnFail: true,
    maxTries: 3,
    waitBetween: 2000,
    parameters: {
      method: "POST",
      url: "={{ $env.SLACK_INCOMING_WEBHOOK }}",
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ text: $json.slackPayload.text }) }}",
      options: {},
    },
  }),
], mergeConns([
  conn("Error Trigger", "Format error"),
  conn("Format error", "Log error"),
  conn("Format error", "Slack error"),
]));

const nurturing = workflow("nurturing-cron", "wf_nurturing_cron", [
  node({
    name: "Every morning",
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position: [0, 300],
    parameters: { rule: { interval: [{ field: "cronExpression", expression: "0 9 * * *" }] } },
  }),
  node({
    name: "Find due C",
    type: "n8n-nodes-base.mongoDb",
    typeVersion: 1.2,
    position: [220, 300],
    parameters: {
      operation: "find",
      collection: "leads",
      options: {},
      query: '={ "tier": "C", "status": { "$ne": "spam" }, "nurturing.nextStepAt": { "$lte": "{{ $now }}" } }',
    },
    credentials: { mongoDb: { id: "CRED_MONGO", name: "MongoDB leadflow" } },
  }),
  node({
    name: "Gmail nurture",
    type: "n8n-nodes-base.gmail",
    typeVersion: 2.1,
    position: [440, 300],
    retryOnFail: true,
    maxTries: 3,
    waitBetween: 2000,
    onError: "continueRegularOutput",
    parameters: {
      sendTo: "={{ $json.emailNormalized }}",
      subject: "Seguimos en trayectoria, {{ $json.firstName || 'hola' }}",
      emailType: "html",
      message: "=<p>Hola {{ $json.fullName }}, te escribimos desde ÓRBITA (demo) con un siguiente paso breve.</p>",
      options: { appendAttribution: false },
    },
    credentials: { gmailOAuth2: { id: "CRED_GMAIL", name: "Gmail ÓRBITA" } },
  }),
], mergeConns([
  conn("Every morning", "Find due C"),
  conn("Find due C", "Gmail nurture"),
]));

const calBooking = workflow("cal-booking", "wf_cal_booking", [
  node({
    name: "Cal webhook",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2.1,
    position: [0, 300],
    webhookId: "cal-booking",
    parameters: {
      httpMethod: "POST",
      path: "cal-booking",
      authentication: "headerAuth",
      responseMode: "lastNode",
      options: {},
    },
    credentials: {
      httpHeaderAuth: { id: "CRED_CAL_HEADER", name: "Cal.com Header Auth" },
    },
  }),
  node({
    name: "Map booking",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [220, 300],
    parameters: {
      jsCode: `const b = $input.first().json.body || $input.first().json;
const trigger = b.triggerEvent || b.trigger || "";
const payload = b.payload || b;
const leadId = (payload.metadata && (payload.metadata.leadId || payload.metadata.leadID)) || "";
const status = String(trigger).includes("CANCEL") ? "cancelled" : "booked";
return [{ json: {
  leadId,
  meeting: {
    status,
    bookingId: payload.uid || payload.id || "",
    startsAt: payload.startTime || payload.start || "",
    title: payload.title || "",
  },
  log: {
    ts: new Date(),
    level: "info",
    leadId,
    submissionId: "",
    executionId: String($execution && $execution.id || ""),
    step: "cal-booking",
    status,
    message: "Cal.com " + trigger + " booking " + (payload.uid || ""),
  }
} }];`,
    },
  }),
  node({
    name: "Update meeting",
    type: "n8n-nodes-base.mongoDb",
    typeVersion: 1.2,
    position: [440, 180],
    parameters: {
      operation: "update",
      collection: "leads",
      updateKey: "leadId",
      fields: "meeting",
      options: { upsert: false },
    },
    credentials: { mongoDb: { id: "CRED_MONGO", name: "MongoDB leadflow" } },
  }),
  node({
    name: "Insert cal log",
    type: "n8n-nodes-base.mongoDb",
    typeVersion: 1.2,
    position: [440, 420],
    parameters: {
      operation: "insert",
      collection: "logs",
      fields: "ts,level,leadId,submissionId,executionId,step,status,message",
      options: {},
    },
    credentials: { mongoDb: { id: "CRED_MONGO", name: "MongoDB leadflow" } },
  }),
], mergeConns([
  conn("Cal webhook", "Map booking"),
  conn("Map booking", "Update meeting"),
  conn("Map booking", "Insert cal log"),
]));

const outbox = workflow("outbox-retry", "wf_outbox_retry", [
  node({
    name: "Every 5 min",
    type: "n8n-nodes-base.scheduleTrigger",
    typeVersion: 1.2,
    position: [0, 300],
    parameters: { rule: { interval: [{ field: "minutes", minutesInterval: 5 }] } },
  }),
  node({
    name: "Find pending",
    type: "n8n-nodes-base.mongoDb",
    typeVersion: 1.2,
    position: [220, 300],
    parameters: {
      operation: "find",
      collection: "submissions",
      options: { limit: 20 },
      query: '{ "status": "pending", "attempts": { "$lt": 5 } }',
    },
    credentials: { mongoDb: { id: "CRED_MONGO", name: "MongoDB leadflow" } },
  }),
  node({
    name: "Replay webhook",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [440, 300],
    retryOnFail: true,
    maxTries: 3,
    waitBetween: 2000,
    onError: "continueRegularOutput",
    parameters: {
      method: "POST",
      url: "={{ $env.N8N_WEBHOOK_INTERNAL_URL || 'http://localhost:5678/webhook/lead-intake' }}",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "Content-Type", value: "application/json" },
          { name: "X-Webhook-Secret", value: "={{ $env.N8N_WEBHOOK_SECRET }}" },
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify($json.payload || $json) }}",
      options: {},
    },
  }),
], mergeConns([
  conn("Every 5 min", "Find pending"),
  conn("Find pending", "Replay webhook"),
]));

const dir = path.join(root, "..", "workflows");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "lead-intake.json"), JSON.stringify(leadIntake, null, 2));
fs.writeFileSync(path.join(dir, "error-handler.json"), JSON.stringify(errorHandler, null, 2));
fs.writeFileSync(path.join(dir, "nurturing-cron.json"), JSON.stringify(nurturing, null, 2));
fs.writeFileSync(path.join(dir, "cal-booking.json"), JSON.stringify(calBooking, null, 2));
fs.writeFileSync(path.join(dir, "outbox-retry.json"), JSON.stringify(outbox, null, 2));
console.log("workflows written", dir);
