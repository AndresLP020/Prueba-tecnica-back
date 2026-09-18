/**
 * Plantillas de correo HTML + texto plano. Pegar en Code node "Email templates"
 * o reutilizar las funciones.
 */

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function confirmationHtml(lead) {
  const name = escapeHtml(lead.firstName || "Hola");
  const intro = escapeHtml(lead.aiIntro || "Recibimos tu señal. El equipo ya está en trayectoria de acercamiento.");
  const cta = lead.bookingUrl
    ? '<p style="margin:24px 0"><a href="' +
      escapeHtml(lead.bookingUrl) +
      '" style="background:#C8FF3D;color:#0A0908;padding:12px 20px;text-decoration:none;font-weight:700">Elegir horario</a></p>'
    : "<p>Te escribiremos con el siguiente paso. No hace falta que agendes ahora.</p>";
  return (
    '<!doctype html><html lang="es-MX"><body style="margin:0;background:#0A0908;color:#F2EDE4;font-family:Georgia,serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0A0908"><tr><td align="center" style="padding:32px 16px">' +
    '<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;border:1px solid #2A2723">' +
    '<tr><td style="padding:28px 28px 8px;font-family:Arial,sans-serif;letter-spacing:.28em;font-size:11px;color:#C8FF3D">ÓRBITA · DEMO</td></tr>' +
    '<tr><td style="padding:8px 28px 0;font-size:28px;line-height:1.1">Tu proyecto ya tiene gravedad, ' +
    name +
    ".</td></tr>" +
    '<tr><td style="padding:16px 28px 8px;color:#8A8478;font-style:italic">' +
    intro +
    "</td></tr>" +
    '<tr><td style="padding:8px 28px 28px;color:#F2EDE4">' +
    cta +
    '<p style="font-size:12px;color:#8A8478">Si no fuiste tú, ignora este correo.</p></td></tr>' +
    "</table></td></tr></table></body></html>"
  );
}

function confirmationText(lead) {
  const name = lead.firstName || "Hola";
  const intro = lead.aiIntro || "Recibimos tu señal. El equipo ya está en trayectoria de acercamiento.";
  const cta = lead.bookingUrl ? "Agenda: " + lead.bookingUrl : "Te escribiremos con el siguiente paso.";
  return (
    "ÓRBITA (demo)\n\n" +
    name +
    ", tu proyecto ya tiene gravedad.\n\n" +
    intro +
    "\n\n" +
    cta +
    "\n\nSi no fuiste tú, ignora este correo."
  );
}

function internalSubject(lead) {
  const tag = lead.flags && lead.flags.spam ? "SPAM" : lead.duplicate ? "REENVÍO" : lead.tier;
  return "[ÓRBITA " + tag + "] " + (lead.fullName || "") + " · " + (lead.company || "");
}

if (typeof $input !== "undefined") {
  return $input.all().map(function (item) {
    const j = item.json;
    j.emailHtml = confirmationHtml(j);
    j.emailText = confirmationText(j);
    j.emailSubject =
      j.flags && j.flags.spam ? "" : "Tu órbita ya está en curso, " + (j.firstName || "");
    j.internalSubject = internalSubject(j);
    return { json: j };
  });
}

if (typeof module !== "undefined") {
  module.exports = {
    confirmationHtml: confirmationHtml,
    confirmationText: confirmationText,
    internalSubject: internalSubject,
  };
}
