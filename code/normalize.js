/**
 * Normaliza el payload del webhook. Pegar en Code node "Normalize lead".
 */
function firstName(full) {
  return String(full || "")
    .trim()
    .split(/\s+/)[0] || "Hola";
}

function nowIso() {
  return new Date().toISOString();
}

function leadId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "ld_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}

if (typeof $input !== "undefined") {
  return $input.all().map(function (item) {
    const src = item.json.body && typeof item.json.body === "object" ? item.json.body : item.json;
    const email = String(src.emailNormalized || src.email || "")
      .trim()
      .toLowerCase();
    const json = Object.assign({}, src, {
      emailNormalized: email,
      fullName: String(src.fullName || "").trim(),
      firstName: firstName(src.fullName),
      company: String(src.company || "").trim(),
      message: String(src.message || "").trim().slice(0, 500),
      leadId: src.leadId || leadId(),
      createdAt: src.createdAt || nowIso(),
      updatedAt: nowIso(),
      timeZone: "America/Mexico_City",
      source: "web_form",
      submissionsCount: 1,
      history: [{ ts: nowIso(), event: "received" }],
      flags: Object.assign(
        {
          confirmationSent: false,
          slackSent: false,
          briefCreated: false,
          calendarEventCreated: false,
          emailValidated: false,
          aiDone: false,
          spam: false,
        },
        src.flags || {},
      ),
    });
    return { json: json };
  });
}

if (typeof module !== "undefined") {
  module.exports = { firstName: firstName };
}
