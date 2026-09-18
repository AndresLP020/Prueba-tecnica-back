import http from "node:http";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import nodemailer from "nodemailer";

const PORT = Number(process.env.PORT || 10000);
const DB_NAME = process.env.MONGODB_DB || "leadflow";

const FREE_EMAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "outlook.com",
  "outlook.es", "yahoo.com", "yahoo.com.mx", "icloud.com", "proton.me", "live.com",
]);

const CORS = {
  "Access-Control-Allow-Origin": process.env.FRONTEND_URL || "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Backend-Secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...CORS,
  });
  res.end(body);
}

function scoreLead(lead, spamRisk = 0) {
  const domain = String(lead.emailNormalized || "").split("@")[1] || "";
  const corporate = domain && !FREE_EMAIL.has(domain);
  const spam = spamRisk >= 0.7 || /viagra|casino online|crypto airdrop/i.test(lead.message || "");
  const budget = { lt10k: 0, "10k_30k": 12, "30k_80k": 25, gt80k: 35 }[lead.budget] || 0;
  const urgency = { exploring: 0, q1: 8, month: 17, asap: 25 }[lead.urgency] || 0;
  const niche = ["ecommerce", "professional_services", "health_wellness", "saas_tech"].includes(lead.niche) ? 15 : 8;
  const need = ["automation", "marketing_leads", "integrations_crm"].includes(lead.need) ? 10 : 6;
  const raw = budget + urgency + niche + need + (corporate ? 10 : 0) + (lead.phoneE164 ? 5 : 0);
  const value = Math.max(0, Math.min(100, raw));
  let tier = "C";
  if (!spam && value >= 70) tier = "A";
  else if (!spam && value >= 40) tier = "B";
  return { score: value, tier, flags: { spam, corporateEmail: corporate } };
}

function bookingUrl(tier) {
  if (tier === "A") return process.env.CAL_BOOKING_A || null;
  if (tier === "B") return process.env.CAL_BOOKING_B || null;
  return null;
}

async function geminiIntro(lead) {
  const key = process.env.LLM_API_KEY;
  const fallback = "No es un acuse de recibo automático. Leímos lo que contaste y ya hay un siguiente movimiento sobre la mesa.";
  if (!key) return { intro: fallback, summary: "Prospecto en evaluación.", spamRisk: 0, intent: "evaluando" };
  const url =
    process.env.LLM_API_URL ||
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent";
  const firstName = String(lead.fullName || "").split(/\s+/)[0] || "Hola";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Voz de ÓRBITA, CDMX, es-MX, de tú, serio y cercano. SOLO JSON: {"summary":"...","intent":"evaluando","spamRisk":0,"intro":"2 frases al prospecto, sin puntaje"}\nNombre:${firstName}\nEmpresa:${lead.company}\nNecesidad:${lead.need}\nMensaje:${String(lead.message || "").slice(0, 200)}`,
          }],
        }],
        generationConfig: { temperature: 0.75, maxOutputTokens: 400 },
      }),
      signal: controller.signal,
    });
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { intro: fallback, summary: fallback, spamRisk: 0, intent: "evaluando" };
    const parsed = JSON.parse(match[0]);
    return {
      intro: String(parsed.intro || fallback).slice(0, 280),
      summary: String(parsed.summary || "").slice(0, 400),
      spamRisk: Number(parsed.spamRisk) || 0,
      intent: parsed.intent || "evaluando",
    };
  } catch {
    return { intro: fallback, summary: "Prospecto en evaluación.", spamRisk: 0, intent: "evaluando" };
  } finally {
    clearTimeout(timer);
  }
}

async function sendMail({ to, firstName, company, bookingUrl, intro, internal }) {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS?.replace(/\s/g, "");
  if (!user || !pass) return false;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user, pass },
  });
  const cta = bookingUrl
    ? `<p><a href="${bookingUrl}" style="background:#1c1915;color:#f4f0e7;padding:14px 22px;text-decoration:none">Reservar conversación</a></p>`
    : "<p>En un día hábil te escribimos con el paso que sí corresponde.</p>";
  await transporter.sendMail({
    from: `"ÓRBITA" <${user}>`,
    to,
    subject: `${firstName}, tu proyecto ya tiene gravedad`,
    html: `<div style="font-family:Georgia,serif;background:#f4f0e7;padding:32px;color:#1c1915">
      <p style="letter-spacing:.3em;color:#8c6b3a">ÓRBITA</p>
      <h1>${firstName}, tu proyecto ya tiene gravedad.</h1>
      <p>${intro}</p>
      <p>Leímos lo de ${company || "tu empresa"} con calma.</p>
      ${cta}
    </div>`,
  });
  if (internal) {
    await transporter.sendMail({
      from: `"ÓRBITA" <${user}>`,
      to: user,
      subject: `[ÓRBITA ${internal.tier}] ${internal.fullName} · ${internal.company}`,
      text: `${internal.fullName}\n${internal.email}\n${internal.company}\n${internal.summary || ""}`,
    });
  }
  return true;
}

let mongoPromise;
function getClient() {
  if (!process.env.MONGODB_URI) throw new Error("Falta MONGODB_URI");
  if (!mongoPromise) mongoPromise = new MongoClient(process.env.MONGODB_URI).connect();
  return mongoPromise;
}

async function ingest(payload) {
  const firstName = String(payload.fullName || "").trim().split(/\s+/)[0] || "Hola";
  const ai = await geminiIntro(payload);
  const scored = scoreLead(payload, ai.spamRisk);
  const url = scored.flags.spam ? null : bookingUrl(scored.tier);
  const db = (await getClient()).db(DB_NAME);
  const leads = db.collection("leads");
  await leads.createIndex({ emailNormalized: 1 }, { unique: true }).catch(() => {});
  const existing = await leads.findOne({ emailNormalized: payload.emailNormalized });
  if (existing) {
    await leads.updateOne(
      { emailNormalized: payload.emailNormalized },
      {
        $inc: { submissionsCount: 1 },
        $set: { updatedAt: new Date(), lastSubmissionId: payload.submissionId, ai },
      },
    );
    return {
      leadId: existing.leadId,
      tier: existing.tier || scored.tier,
      bookingUrl: existing.bookingUrl || url,
      duplicate: true,
      emailSent: false,
    };
  }
  const leadId = randomUUID();
  await leads.insertOne({
    ...payload,
    leadId,
    score: scored.score,
    tier: scored.tier,
    status: scored.flags.spam ? "spam" : "active",
    flags: { ...scored.flags, spamRisk: ai.spamRisk },
    ai,
    bookingUrl: url,
    submissionsCount: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  let emailSent = false;
  if (!scored.flags.spam) {
    try {
      emailSent = await sendMail({
        to: payload.emailNormalized,
        firstName,
        company: payload.company,
        bookingUrl: url,
        intro: ai.intro,
        internal: {
          fullName: payload.fullName,
          company: payload.company,
          tier: scored.tier,
          email: payload.emailNormalized,
          summary: ai.summary,
        },
      });
    } catch (err) {
      console.error("mail", err);
    }
  }
  return { leadId, tier: scored.tier, bookingUrl: url, duplicate: false, emailSent };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    json(res, 200, { ok: true, service: "orbita-api" });
    return;
  }
  if (req.method === "POST" && req.url === "/api/leads") {
    const secret = process.env.BACKEND_SECRET;
    if (secret && req.headers["x-backend-secret"] !== secret) {
      json(res, 401, { ok: false, error: "No autorizado" });
      return;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      if (!payload?.emailNormalized || !payload.fullName) {
        json(res, 400, { ok: false, error: "Payload incompleto" });
        return;
      }
      const result = await ingest(payload);
      json(res, 200, result);
    } catch (err) {
      console.error(err);
      json(res, 500, { ok: false, error: "No pudimos completar el envío." });
    }
    return;
  }
  json(res, 404, { ok: false });
});

server.listen(PORT, () => {
  console.log(`ÓRBITA API en puerto ${PORT}`);
});
