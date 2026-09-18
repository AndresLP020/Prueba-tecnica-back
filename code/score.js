/**
 * Lead scoring — pegar tal cual en el Code node de n8n
 * (modo: Run Once for All Items).
 * Los tests lo importan con require().
 *
 * Total = clamp(suma - penalizaciones, 0, 100)
 * Tier: A ≥ 70 · B 40–69 · C < 40
 * spamRisk ≥ 0.7 → fuerza C, flags.spam = true (no altera el número salvo la UI de ruteo)
 */

const FREE_EMAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.es",
  "outlook.com",
  "outlook.es",
  "yahoo.com",
  "yahoo.com.mx",
  "yahoo.es",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "live.com",
  "msn.com",
  "aol.com",
  "yopmail.com",
  "gmx.com",
  "gmx.es",
  "mail.com",
  "zoho.com",
];

const DISPOSABLE_DOMAINS = [
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "throwaway.email",
  "trashmail.com",
  "getnada.com",
  "temp-mail.org",
  "fakeinbox.com",
  "maildrop.cc",
  "sharklasers.com",
  "guerrillamailblock.com",
  "yopmail.com",
  "dispostable.com",
  "mailnesia.com",
  "guerrillamail.org",
  "grr.la",
  "discard.email",
];

const IDEAL_NICHES = [
  "ecommerce",
  "professional_services",
  "health_wellness",
  "saas_tech",
];

const LISTED_NICHES = [
  "ecommerce",
  "professional_services",
  "health_wellness",
  "saas_tech",
  "real_estate",
  "education",
  "restaurants_hospitality",
];

const CORE_NEEDS = ["automation", "marketing_leads", "integrations_crm"];
const SITE_BRAND_NEEDS = ["website_landing", "branding_design"];

const BUDGET_POINTS = {
  lt10k: 0,
  "10k_30k": 12,
  "30k_80k": 25,
  gt80k: 35,
};

const URGENCY_POINTS = {
  exploring: 0,
  q1: 8,
  month: 17,
  asap: 25,
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function domainFromEmail(email) {
  const normalized = String(email || "")
    .trim()
    .toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at >= 0 ? normalized.slice(at + 1) : "";
}

function isCorporateEmail(email) {
  const domain = domainFromEmail(email);
  return domain.length > 0 && FREE_EMAIL_DOMAINS.indexOf(domain) === -1;
}

function isDisposableEmail(email, enrichment) {
  if (enrichment && enrichment.disposable === true) return true;
  if (enrichment && enrichment.is_disposable_email) {
    const flag = enrichment.is_disposable_email;
    if (flag === true || (flag && flag.value === true)) return true;
  }
  const domain = domainFromEmail(email);
  return DISPOSABLE_DOMAINS.indexOf(domain) !== -1;
}

function heuristicSpamRisk(lead) {
  const msg = String(lead.message || "").toLowerCase();
  if (
    /viagra|casino online|crypto airdrop|seo backlinks|nudes/.test(msg)
  ) {
    return 0.85;
  }
  return 0;
}

function calculateScore(lead) {
  const email = lead.emailNormalized || lead.email || "";
  const enrichment =
    (lead.enrichment && lead.enrichment.emailCheck) || lead.emailCheck || null;

  const breakdown = {
    budget: BUDGET_POINTS[lead.budget] != null ? BUDGET_POINTS[lead.budget] : 0,
    urgency:
      URGENCY_POINTS[lead.urgency] != null ? URGENCY_POINTS[lead.urgency] : 0,
    niche: IDEAL_NICHES.indexOf(lead.niche) !== -1
      ? 15
      : LISTED_NICHES.indexOf(lead.niche) !== -1
        ? 8
        : 0,
    need:
      CORE_NEEDS.indexOf(lead.need) !== -1
        ? 10
        : SITE_BRAND_NEEDS.indexOf(lead.need) !== -1
          ? 6
          : 0,
    corporateEmail: isCorporateEmail(email) ? 10 : 0,
    validPhone: lead.phoneValid === true || Boolean(lead.phoneE164) ? 5 : 0,
    disposablePenalty: 0,
  };

  const disposable = isDisposableEmail(email, enrichment);
  if (disposable) breakdown.disposablePenalty = 25;

  const raw =
    breakdown.budget +
    breakdown.urgency +
    breakdown.niche +
    breakdown.need +
    breakdown.corporateEmail +
    breakdown.validPhone -
    breakdown.disposablePenalty;

  const score = clamp(raw, 0, 100);

  const flags = {
    spam: false,
    disposableEmail: disposable,
    corporateEmail: breakdown.corporateEmail === 10,
  };

  const spamRisk =
    typeof lead.spamRisk === "number"
      ? lead.spamRisk
      : lead.flags && typeof lead.flags.spamRisk === "number"
        ? lead.flags.spamRisk
        : heuristicSpamRisk(lead);

  if (spamRisk >= 0.7) {
    flags.spam = true;
  }

  let tier = "C";
  if (!flags.spam && score >= 70) tier = "A";
  else if (!flags.spam && score >= 40) tier = "B";
  else tier = "C";

  return { score: score, tier: tier, breakdown: breakdown, flags: flags, spamRisk: spamRisk };
}

function bookingUrlForTier(tier, calBase) {
  const base = (calBase || "https://cal.com/orbita").replace(/\/$/, "");
  if (tier === "A") return base + "/priority-15min";
  if (tier === "B") return base + "/discovery-30min";
  return null;
}

function applyScoringToItem(json) {
  const payload =
    json && json.body && typeof json.body === "object"
      ? Object.assign({}, json, json.body)
      : json || {};
  const result = calculateScore(payload);
  const calBase = payload.calBaseUrl || payload.CAL_BASE_URL;
  const bookingUrl = result.flags.spam
    ? null
    : bookingUrlForTier(result.tier, calBase);
  return Object.assign({}, payload, {
    scoring: result,
    score: result.score,
    tier: result.tier,
    flags: Object.assign({}, payload.flags || {}, result.flags),
    bookingUrl: bookingUrl,
  });
}

if (typeof $input !== "undefined") {
  return $input.all().map(function (item) {
    return { json: applyScoringToItem(item.json) };
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    calculateScore: calculateScore,
    applyScoringToItem: applyScoringToItem,
    isCorporateEmail: isCorporateEmail,
    isDisposableEmail: isDisposableEmail,
    bookingUrlForTier: bookingUrlForTier,
    FREE_EMAIL_DOMAINS: FREE_EMAIL_DOMAINS,
    DISPOSABLE_DOMAINS: DISPOSABLE_DOMAINS,
  };
}
