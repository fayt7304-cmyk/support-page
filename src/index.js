const HOME_PATH = "/";
const SUBMIT_PATH = "/submit";
const THEME_SCRIPT_PATH = "/theme.js";
const TURNSTILE_ACTION = "support_request";

const REQUEST_TYPES = {
  devis: "Devis / commande",
  livraison: "Livraison & pose",
  sav: "SAV / qualité",
  entretien: "Entretien / cristallisation",
  facture: "Facture / paiement",
  autre: "Autre demande",
};

const CONTACT_METHODS = {
  email: "E-mail",
  telephone: "Téléphone",
  whatsapp: "WhatsApp",
};

const BRAND_IMAGE =
  "https://afmarbre.com/wp-content/uploads/2025/09/minimalist-office-interior-design-1024x683.jpg";

const BRAND_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="10" fill="#f5f2ec"/>
  <rect x="6.5" y="6.5" width="51" height="51" rx="7" fill="none" stroke="#a59786"/>
  <text x="32" y="39" text-anchor="middle" font-family="Georgia,Times New Roman,serif" font-size="22" fill="#181715">A·F</text>
</svg>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if ((url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") && request.method === "GET") {
      return new Response(BRAND_FAVICON_SVG, {
        headers: {
          "content-type": "image/svg+xml; charset=UTF-8",
          "cache-control": "public, max-age=604800, immutable",
          "x-content-type-options": "nosniff",
        },
      });
    }

    // Redirect the previous /support URL to the new support subdomain root.
    if ((url.pathname === "/support" || url.pathname === "/support/") && request.method === "GET") {
      return Response.redirect(`${url.origin}/`, 308);
    }

    if (url.pathname === HOME_PATH && (request.method === "GET" || request.method === "HEAD")) {
      const success = url.searchParams.get("success") === "1";
      const ticket = cleanTicket(url.searchParams.get("ticket"));

      const html = renderPage(env, {
        successMessage: success && ticket ? ticket : "",
        successTicket: success && ticket ? ticket : "",
      });

      return htmlResponse(request.method === "HEAD" ? "" : html, 200);
    }

    if (url.pathname === SUBMIT_PATH && request.method === "POST") {
      return handleSupportRequest(request, env);
    }

    if (url.pathname === THEME_SCRIPT_PATH && request.method === "GET") {
      return new Response(renderThemeScript(), {
        headers: {
          "content-type": "application/javascript; charset=UTF-8",
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ ok: true, service: "afmarbre-support" }), {
        headers: {
          "content-type": "application/json; charset=UTF-8",
          "cache-control": "no-store",
        },
      });
    }

    // Privacy-friendly counters: event name only, no personal data.
    if (url.pathname === "/metrics" && request.method === "POST") {
      try {
        const body = await request.json();
        const event = String(body?.event || "").slice(0, 40);
        const allowed = new Set([
          "page_view",
          "form_submit_ok",
          "form_submit_error",
          "turnstile_fail",
          "ticket_lookup",
          "lang_change",
        ]);
        if (allowed.has(event)) {
          console.log(JSON.stringify({ type: "support_metric", event, t: Date.now() }));
        }
      } catch {
        /* ignore bad bodies */
      }
      return new Response(null, { status: 204 });
    }

    // Proxy Better Stack public status JSON (avoids browser CORS issues).
    if (url.pathname === "/status-summary" && request.method === "GET") {
      try {
        const statusUrl = env.STATUS_JSON_URL || "https://status.afmarbre.com/index.json";
        const resp = await fetch(statusUrl, {
          headers: { accept: "application/json" },
          cf: { cacheTtl: 60, cacheEverything: true },
        });
        if (!resp.ok) {
          return new Response(JSON.stringify({ ok: false, state: "unknown" }), {
            status: 200,
            headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "public, max-age=30" },
          });
        }
        const data = await resp.json();
        const attrs = data?.data?.attributes || {};
        return new Response(
          JSON.stringify({
            ok: true,
            state: attrs.aggregate_state || "unknown",
            announcement: attrs.announcement || null,
            updated_at: attrs.updated_at || null,
            url: "https://status.afmarbre.com/",
          }),
          {
            headers: {
              "content-type": "application/json; charset=UTF-8",
              "cache-control": "public, max-age=60",
            },
          }
        );
      } catch (e) {
        console.error("status-summary failed", e?.message || e);
        return new Response(JSON.stringify({ ok: false, state: "unknown", url: "https://status.afmarbre.com/" }), {
          status: 200,
          headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "public, max-age=30" },
        });
      }
    }

    return htmlResponse(renderNotFound(), 404);
  },
};

async function handleSupportRequest(request, env) {
  const length = Number(request.headers.get("content-length") || "0");
  if (length > 64_000) {
    return htmlResponse(
      renderPage(env, { errorMessage: "La demande est trop volumineuse." }),
      413
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return htmlResponse(
      renderPage(env, {
        errorMessage: "Le formulaire est invalide. Veuillez actualiser la page puis réessayer.",
      }),
      400
    );
  }

  // Honeypot. Do not reveal to bots that their submission was discarded.
  if (field(form, "website")) {
    return Response.redirect(`${new URL(request.url).origin}/?success=1&ticket=AFM-RECU`, 303);
  }

  const data = {
    name: field(form, "name"),
    email: field(form, "email").toLowerCase(),
    phone: field(form, "phone"),
    reference: field(form, "reference"),
    type: field(form, "type"),
    contact: field(form, "contact"),
    subject: oneLine(field(form, "subject")),
    message: field(form, "message"),
  };

  const validationError = validateRequest(data);
  if (validationError) {
    return htmlResponse(renderPage(env, { errorMessage: validationError }), 400);
  }

  if (
    !env.TURNSTILE_SECRET ||
    !env.TURNSTILE_SITE_KEY ||
    env.TURNSTILE_SITE_KEY.startsWith("REPLACE_")
  ) {
    return htmlResponse(
      renderPage(env, {
        errorMessage:
          "Le formulaire est en cours de configuration. Vous pouvez nous joindre directement par téléphone ou WhatsApp.",
      }),
      503
    );
  }

  const token = field(form, "cf-turnstile-response");
  const turnstile = await verifyTurnstile(request, env, token);

  if (!turnstile.ok) {
    return htmlResponse(
      renderPage(env, {
        errorMessage:
          "La vérification anti-spam a échoué ou a expiré. Actualisez la page puis réessayez.",
      }),
      403
    );
  }

  if (!env.AFMARBRE_API) {
    return htmlResponse(
      renderPage(env, {
        errorMessage:
          "Le service d’envoi n’est pas encore configuré. Merci d’utiliser WhatsApp ou le téléphone.",
      }),
      503
    );
  }

  if (!env.SUPPORT_API_TOKEN) {
    return htmlResponse(
      renderPage(env, {
        errorMessage:
          "Le service d’envoi n’est pas encore configuré. Merci d’utiliser WhatsApp ou le téléphone.",
      }),
      503
    );
  }

  const ticket = makeTicketId();
  const typeLabel = REQUEST_TYPES[data.type];
  const contactLabel = CONTACT_METHODS[data.contact];

  try {
    const apiRequest = new Request("https://support.afmarbre.internal/api/support", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "authorization": `Bearer ${env.SUPPORT_API_TOKEN}`,
        "user-agent": "afmarbre-support-worker/2.0",
      },
      body: JSON.stringify({
        ticket,
        name: data.name,
        email: data.email,
        phone: data.phone,
        reference: data.reference,
        type: data.type,
        type_label: typeLabel,
        contact: data.contact,
        contact_label: contactLabel,
        subject: data.subject,
        message: data.message,
        client_ip: request.headers.get("CF-Connecting-IP") || "",
      }),
    });

    // Cloudflare Service Binding: no public DNS hop; still uses SUPPORT_API_TOKEN for auth on the API Worker.
    const apiResponse = await env.AFMARBRE_API.fetch(apiRequest);

    if (!apiResponse.ok) {
      const detail = (await apiResponse.text()).slice(0, 800);
      console.error("Support Resend service failed:", apiResponse.status, detail);
      throw new Error(`Support service returned ${apiResponse.status}`);
    }
  } catch (error) {
    console.error("Support email failed:", error?.message || error);
    return htmlResponse(
      renderPage(env, {
        errorMessage:
          "Votre demande n’a pas pu être envoyée pour le moment. Merci d’utiliser WhatsApp ou de réessayer plus tard.",
      }),
      502
    );
  }

  const redirectUrl = new URL("/", request.url);
  redirectUrl.searchParams.set("success", "1");
  redirectUrl.searchParams.set("ticket", ticket);
  return Response.redirect(redirectUrl.toString(), 303);
}

async function verifyTurnstile(request, env, token) {
  if (!token || token.length > 2048) return { ok: false };

  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
    remoteip: request.headers.get("CF-Connecting-IP") || "",
  });

  let result;
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }
    );

    if (!response.ok) return { ok: false };
    result = await response.json();
  } catch (error) {
    console.error("Turnstile error:", error);
    return { ok: false };
  }

  const hostnames = new Set(
    String(env.TURNSTILE_HOSTNAMES || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );

  const hostnameOk =
    hostnames.size > 0 &&
    typeof result.hostname === "string" &&
    hostnames.has(result.hostname.toLowerCase());

  return {
    ok:
      result.success === true &&
      result.action === TURNSTILE_ACTION &&
      hostnameOk,
  };
}

function validateRequest(data) {
  if (data.name.length < 2 || data.name.length > 100) {
    return "Veuillez saisir votre nom complet.";
  }

  if (
    data.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)
  ) {
    return "Veuillez saisir une adresse e-mail valide.";
  }

  if (data.phone.length > 40) {
    return "Le numéro de téléphone est trop long.";
  }

  if (data.reference.length > 80) {
    return "La référence devis / commande est trop longue.";
  }

  if (!Object.hasOwn(REQUEST_TYPES, data.type)) {
    return "Veuillez sélectionner un type de demande.";
  }

  if (!Object.hasOwn(CONTACT_METHODS, data.contact)) {
    return "Veuillez sélectionner votre moyen de contact préféré.";
  }

  if (data.subject.length < 3 || data.subject.length > 160) {
    return "Le sujet doit contenir entre 3 et 160 caractères.";
  }

  if (data.message.length < 10 || data.message.length > 5000) {
    return "Le message doit contenir entre 10 et 5000 caractères.";
  }

  return "";
}

function renderPage(env, { successMessage = "", errorMessage = "", successTicket = "" } = {}) {
  const siteKey =
    env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SITE_KEY.startsWith("REPLACE_")
      ? env.TURNSTILE_SITE_KEY
      : "";

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#181715">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="shortcut icon" href="/favicon.svg">
  <title>Support client | A-F Marbre</title>
  <meta name="description" content="Assistance A-F Marbre pour vos devis, commandes, livraisons, poses, travaux d’entretien, cristallisation et demandes SAV.">
  <link rel="canonical" href="https://support.afmarbre.com/">
  <script src="/theme.js"></script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    :root {
      --ink: #181715;
      --ink-soft: #272522;
      --paper: #f5f2ec;
      --paper-deep: #ece6dd;
      --surface: #fffdf9;
      --surface-2: #f9f6f1;
      --line: #dcd4c9;
      --line-dark: rgba(255,255,255,.17);
      --muted: #716b62;
      --stone: #a78255;
      --stone-deep: #7a5b38;
      --stone-light: #d4bea0;
      --success: #e9f2e9;
      --success-ink: #285632;
      --error: #f8e9e6;
      --error-ink: #842f27;
      --shadow: 0 26px 70px rgba(32, 27, 21, .11);
      --shadow-soft: 0 12px 35px rgba(32, 27, 21, .07);
    }

    * { box-sizing: border-box; }

    html { scroll-behavior: smooth; }

    body {
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(rgba(102, 85, 64, .035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(102, 85, 64, .035) 1px, transparent 1px),
        var(--paper);
      background-size: 48px 48px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }

    a { color: inherit; }

    .shell {
      width: min(1180px, calc(100% - 40px));
      margin: 0 auto;
    }

    .topbar {
      background: var(--ink);
      color: #e8e2d9;
      font-size: 12px;
    }

    .topbar-inner {
      min-height: 34px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
    }

    .topbar a {
      text-decoration: none;
      color: #fff;
    }

    .topbar a:hover { text-decoration: underline; }

    header {
      position: sticky;
      top: 0;
      z-index: 30;
      border-bottom: 1px solid rgba(84, 72, 57, .14);
      background: rgba(245, 242, 236, .9);
      backdrop-filter: blur(18px);
    }

    .nav {
      min-height: 80px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 15px;
      text-decoration: none;
    }

    .brand-mark {
      width: 46px;
      height: 46px;
      display: grid;
      place-items: center;
      border: 1px solid #a59786;
      background:
        linear-gradient(135deg, rgba(255,255,255,.96), rgba(227,219,208,.9));
      font-family: Georgia, "Times New Roman", serif;
      font-size: 17px;
      letter-spacing: -.08em;
      box-shadow: inset 0 0 0 5px rgba(255,255,255,.34);
    }

    .brand-copy strong {
      display: block;
      font-family: Georgia, "Times New Roman", serif;
      font-size: 21px;
      font-weight: 500;
      letter-spacing: .02em;
    }

    .brand-copy small {
      display: block;
      margin-top: 1px;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .18em;
    }

    .nav-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .nav-link,
    .nav-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      padding: 0 15px;
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
    }

    .nav-link { color: #4e4942; }

    .nav-link:hover { color: var(--ink); }

    .nav-button {
      border: 1px solid var(--ink);
      background: var(--ink);
      color: #fff;
    }

    .hero {
      padding: 44px 0 36px;
    }

    .hero-frame {
      position: relative;
      min-height: 580px;
      overflow: hidden;
      background: var(--ink);
      box-shadow: var(--shadow);
    }

    .hero-frame::after {
      content: "";
      position: absolute;
      inset: 0;
      background:
        linear-gradient(90deg, rgba(18,17,15,.96) 0%, rgba(18,17,15,.87) 36%, rgba(18,17,15,.2) 69%, rgba(18,17,15,.12) 100%),
        linear-gradient(0deg, rgba(18,17,15,.32), transparent 60%);
      z-index: 1;
    }

    .hero-image {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center;
      opacity: .92;
    }

    .hero-content {
      position: relative;
      z-index: 2;
      width: min(650px, 66%);
      min-height: 580px;
      padding: 74px 68px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      color: #fff;
    }

    .kicker {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
      color: var(--stone-light);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .2em;
    }

    .kicker::before {
      content: "";
      width: 42px;
      height: 1px;
      background: currentColor;
    }

    .hero h1 {
      max-width: 620px;
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(48px, 6.6vw, 82px);
      line-height: .98;
      font-weight: 400;
      letter-spacing: -.045em;
    }

    .hero-lead {
      max-width: 560px;
      margin: 26px 0 0;
      color: #ddd5ca;
      font-size: 17px;
      line-height: 1.7;
    }

    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 34px;
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      padding: 0 19px;
      border: 1px solid transparent;
      text-decoration: none;
      font-size: 13px;
      font-weight: 800;
      transition: transform .16s ease, background .16s ease, border-color .16s ease;
    }

    .button:hover { transform: translateY(-1px); }

    .button-light {
      background: #fff;
      color: var(--ink);
    }

    .button-ghost {
      border-color: rgba(255,255,255,.4);
      color: #fff;
      background: rgba(255,255,255,.04);
    }

    .hero-note {
      position: absolute;
      right: 30px;
      bottom: 28px;
      z-index: 3;
      width: 230px;
      padding: 17px 18px;
      border: 1px solid rgba(255,255,255,.25);
      background: rgba(19,18,16,.68);
      backdrop-filter: blur(12px);
      color: #fff;
    }

    .hero-note span {
      display: block;
      color: #c7bdaf;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .16em;
    }

    .hero-note strong {
      display: block;
      margin-top: 5px;
      font-family: Georgia, serif;
      font-size: 20px;
      font-weight: 400;
    }

    .contact-strip {
      display: grid;
      grid-template-columns: 1.15fr 1fr 1fr 1fr 1.15fr;
      background: var(--surface);
      border: 1px solid var(--line);
      box-shadow: var(--shadow-soft);
      margin-bottom: 74px;
    }

    .contact-item {
      min-height: 112px;
      padding: 24px 25px;
      border-right: 1px solid var(--line);
      text-decoration: none;
    }

    .contact-item:last-child { border-right: 0; }

    .contact-item .label {
      display: block;
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .16em;
    }

    .contact-item strong {
      display: block;
      margin-top: 8px;
      font-family: Georgia, serif;
      font-size: 19px;
      font-weight: 400;
      line-height: 1.25;
    }

    a.contact-item:hover strong { color: var(--stone-deep); }

    .section {
      padding: 0 0 88px;
    }

    .section-head {
      max-width: 710px;
      margin-bottom: 30px;
    }

    .section-head .eyebrow {
      color: var(--stone-deep);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .18em;
    }

    .section-head h2 {
      margin: 9px 0 12px;
      font-family: Georgia, "Times New Roman", serif;
      font-size: clamp(34px, 4.5vw, 52px);
      line-height: 1.05;
      font-weight: 400;
      letter-spacing: -.035em;
    }

    .section-head p {
      margin: 0;
      color: var(--muted);
      font-size: 16px;
    }

    .support-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.55fr) minmax(300px, .72fr);
      gap: 24px;
      align-items: start;
    }

    .card {
      border: 1px solid var(--line);
      background: var(--surface);
      box-shadow: var(--shadow-soft);
    }

    .form-card { padding: 38px; }

    .form-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 25px;
      margin-bottom: 30px;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--line);
    }

    .form-top h3 {
      margin: 0;
      font-family: Georgia, serif;
      font-size: 30px;
      font-weight: 400;
    }

    .form-top p {
      max-width: 470px;
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    .secure-badge {
      flex: 0 0 auto;
      padding: 8px 10px;
      border: 1px solid #d8d0c4;
      background: var(--surface-2);
      color: #5f584f;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .12em;
    }

    .notice {
      padding: 15px 17px;
      margin: 0 0 22px;
      font-size: 14px;
      border-left: 3px solid currentColor;
    }

    .notice.success {
      color: var(--success-ink);
      background: var(--success);
    }

    .notice.error {
      color: var(--error-ink);
      background: var(--error);
    }

    form {
      display: grid;
      gap: 18px;
    }

    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    label {
      display: block;
      margin-bottom: 7px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: .01em;
    }

    input,
    select,
    textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 0;
      background: #fff;
      color: var(--ink);
      font: inherit;
      padding: 13px 14px;
      outline: none;
      transition: border-color .15s ease, box-shadow .15s ease;
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: var(--stone);
      box-shadow: 0 0 0 3px rgba(167, 130, 85, .12);
    }

    textarea {
      min-height: 160px;
      resize: vertical;
    }

    .field-help {
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
    }

    .trap {
      position: absolute;
      left: -9999px;
      opacity: 0;
      pointer-events: none;
    }

    .turnstile {
      min-height: 66px;
      display: flex;
      align-items: center;
    }

    .submit-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      padding-top: 3px;
    }

    button[type="submit"] {
      min-height: 50px;
      padding: 0 23px;
      border: 1px solid var(--ink);
      background: var(--ink);
      color: #fff;
      font: inherit;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
    }

    button[type="submit"]:hover { background: #2a2825; }

    .privacy {
      max-width: 390px;
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      text-align: right;
    }

    .side {
      display: grid;
      gap: 20px;
    }

    .side-card { padding: 28px; }

    .side-card.dark {
      background: var(--ink);
      color: #fff;
      border-color: var(--ink);
    }

    .chatbot-card {
      position: relative;
      overflow: hidden;
      background:
        linear-gradient(135deg, rgba(167,130,85,.11), transparent 58%),
        var(--surface);
    }

    .chatbot-card::after {
      content: "AI";
      position: absolute;
      right: 18px;
      top: 10px;
      color: rgba(167,130,85,.12);
      font-family: Georgia, serif;
      font-size: 72px;
      line-height: 1;
    }

    .chatbot-card .eyebrow {
      position: relative;
      z-index: 1;
      color: var(--stone-deep);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .16em;
    }

    .chatbot-card h3,
    .chatbot-card p,
    .chatbot-card .chat-button {
      position: relative;
      z-index: 1;
    }

    .chat-button {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 48px;
      margin-top: 21px;
      border: 1px solid var(--ink);
      background: var(--ink);
      color: #fff;
      text-decoration: none;
      font-size: 13px;
      font-weight: 800;
    }

    .chat-button:hover {
      background: var(--stone-deep);
      border-color: var(--stone-deep);
    }


    .side-card h3 {
      margin: 0;
      font-family: Georgia, serif;
      font-size: 28px;
      font-weight: 400;
    }

    .side-card > p {
      margin: 9px 0 0;
      color: var(--muted);
      font-size: 14px;
    }

    .side-card.dark > p { color: #bdb4a8; }

    .support-list {
      display: grid;
      gap: 0;
      margin-top: 23px;
    }

    .support-line {
      padding: 16px 0;
      border-top: 1px solid var(--line);
    }

    .side-card.dark .support-line { border-color: var(--line-dark); }

    .support-line span {
      display: block;
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .13em;
    }

    .side-card.dark .support-line span { color: #a89f94; }

    .support-line strong,
    .support-line a {
      display: block;
      margin-top: 4px;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
    }

    .side-card.dark .support-line a:hover { color: var(--stone-light); }

    .wa-button {
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 48px;
      margin-top: 21px;
      border: 1px solid #fff;
      color: #fff;
      text-decoration: none;
      font-size: 13px;
      font-weight: 800;
    }

    .wa-button:hover {
      background: #fff;
      color: var(--ink);
    }

    .wa-button + .wa-button {
      margin-top: 10px;
    }

    .mini-links {
      display: grid;
      margin-top: 20px;
    }

    .mini-links a {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 13px 0;
      border-top: 1px solid var(--line);
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
    }

    .mini-links a::after {
      content: "↗";
      color: var(--stone-deep);
    }

    .services {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      border: 1px solid var(--line);
      background: var(--surface);
    }

    .service {
      min-height: 220px;
      padding: 29px;
      border-right: 1px solid var(--line);
    }

    .service:last-child { border-right: 0; }

    .service .num {
      color: var(--stone);
      font-family: Georgia, serif;
      font-size: 16px;
    }

    .service h3 {
      margin: 48px 0 9px;
      font-family: Georgia, serif;
      font-size: 25px;
      font-weight: 400;
    }

    .service p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }

    .faq-grid {
      display: grid;
      grid-template-columns: .72fr 1.28fr;
      gap: 50px;
      align-items: start;
    }

    .faq-title h2 {
      margin: 8px 0 12px;
      font-family: Georgia, serif;
      font-size: 42px;
      font-weight: 400;
      line-height: 1.05;
    }

    .faq-title p {
      color: var(--muted);
      font-size: 14px;
    }

    .faq {
      border-top: 1px solid var(--line);
    }

    details {
      border-bottom: 1px solid var(--line);
    }

    summary {
      position: relative;
      padding: 21px 42px 21px 0;
      cursor: pointer;
      list-style: none;
      font-size: 15px;
      font-weight: 750;
    }

    summary::-webkit-details-marker { display: none; }

    summary::after {
      content: "+";
      position: absolute;
      right: 2px;
      top: 17px;
      color: var(--stone-deep);
      font-family: Georgia, serif;
      font-size: 24px;
      font-weight: 400;
    }

    details[open] summary::after { content: "−"; }

    details p {
      max-width: 690px;
      margin: -4px 0 21px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.7;
    }

    footer {
      background: var(--ink);
      color: #cec6bb;
      padding: 44px 0 36px;
    }

    .footer-grid {
      display: grid;
      grid-template-columns: 1.3fr 1fr 1fr;
      gap: 40px;
    }

    .footer-brand strong {
      display: block;
      color: #fff;
      font-family: Georgia, serif;
      font-size: 25px;
      font-weight: 400;
    }

    .footer-brand p {
      max-width: 410px;
      margin: 11px 0 0;
      color: #a99f92;
      font-size: 13px;
    }

    .footer-col span {
      display: block;
      margin-bottom: 12px;
      color: #8f867a;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: .16em;
    }

    .footer-col a {
      display: block;
      width: fit-content;
      margin: 6px 0;
      color: #e5ded5;
      text-decoration: none;
      font-size: 13px;
    }

    .footer-col a:hover { color: #fff; }

    .footer-bottom {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      margin-top: 38px;
      padding-top: 22px;
      border-top: 1px solid var(--line-dark);
      color: #81786d;
      font-size: 11px;
    }

    /* Shared A-F Marbre appearance control */
    .theme-switch {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      border: 1px solid var(--line);
      background: var(--surface-2);
    }

    .theme-switch button {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: 15px;
    }

    .theme-switch button:hover {
      color: var(--ink);
      background: var(--paper-deep);
    }

    .theme-switch button.active,
    .theme-switch button[aria-pressed="true"] {
      background: var(--ink);
      color: var(--surface);
    }

    html[data-theme="dark"] {
      --ink: #f3eee6;
      --ink-soft: #e5ddd2;
      --paper: #12110f;
      --paper-deep: #1b1916;
      --surface: #1a1917;
      --surface-2: #211f1c;
      --line: #3a352f;
      --line-dark: rgba(255,255,255,.14);
      --muted: #aaa197;
      --stone: #c8a873;
      --stone-deep: #ddc18e;
      --stone-light: #e2cda7;
      --success: #193021;
      --success-ink: #a9d7b0;
      --error: #3b201d;
      --error-ink: #ffaaa0;
      --shadow: 0 26px 70px rgba(0,0,0,.34);
      --shadow-soft: 0 12px 35px rgba(0,0,0,.24);
    }

    html[data-theme="dark"] body {
      background:
        linear-gradient(rgba(220,190,145,.028) 1px, transparent 1px),
        linear-gradient(90deg, rgba(220,190,145,.028) 1px, transparent 1px),
        var(--paper);
    }

    html[data-theme="dark"] .topbar,
    html[data-theme="dark"] .hero-frame,
    html[data-theme="dark"] .side-card.dark,
    html[data-theme="dark"] footer {
      background: #181715;
    }

    html[data-theme="dark"] header {
      border-bottom-color: rgba(255,255,255,.08);
      background: rgba(18,17,15,.9);
    }

    html[data-theme="dark"] .brand-mark {
      border-color: #625b51;
      background: linear-gradient(135deg, #292620, #1d1b18);
      box-shadow: inset 0 0 0 5px rgba(255,255,255,.025);
    }

    html[data-theme="dark"] .nav-link { color: #c0b7aa; }
    html[data-theme="dark"] .nav-link:hover { color: #fff; }

    html[data-theme="dark"] .nav-button,
    html[data-theme="dark"] button[type="submit"],
    html[data-theme="dark"] .chat-button {
      border-color: #f3eee6;
      background: #f3eee6;
      color: #181715;
    }

    html[data-theme="dark"] button[type="submit"]:hover,
    html[data-theme="dark"] .chat-button:hover {
      border-color: var(--stone);
      background: var(--stone);
      color: #181715;
    }

    html[data-theme="dark"] input,
    html[data-theme="dark"] select,
    html[data-theme="dark"] textarea {
      background: #151412;
      color: var(--ink);
    }

    html[data-theme="dark"] .button-light { color: #181715; }
    html[data-theme="dark"] .wa-button:hover { color: #181715; }
    html[data-theme="dark"] .card { background: var(--surface); }
    html[data-theme="dark"] .secure-badge { background: var(--surface-2); color: var(--muted); }
    html[data-theme="dark"] .contact-strip { background: var(--surface); }
    html[data-theme="dark"] .footer-brand strong,
    html[data-theme="dark"] .footer-col a:hover { color: #fff; }

    @media (max-width: 940px) {
      .hero-content {
        width: 76%;
        padding: 62px 46px;
      }

      .contact-strip { grid-template-columns: 1fr 1fr; }
      .contact-item { border-bottom: 1px solid var(--line); }
      .contact-item:nth-child(even) { border-right: 0; }
      .contact-item:last-child { border-bottom: 0; }

      .support-layout { grid-template-columns: 1fr; }
      .side { grid-template-columns: 1fr 1fr; }

      .faq-grid { grid-template-columns: 1fr; gap: 20px; }
    }

    @media (max-width: 720px) {
      .shell { width: min(100% - 24px, 1180px); }

      .topbar-inner {
        min-height: 38px;
        justify-content: center;
      }

      .topbar-inner span:last-child { display: none; }

      .nav { min-height: 70px; }
      .brand-mark { width: 40px; height: 40px; }
      .brand-copy strong { font-size: 18px; }
      .nav-link { display: none; }
      .nav { gap: 10px; }
      .theme-switch button { width: 31px; height: 31px; }
      .nav-button { display: none; }

      .hero { padding-top: 20px; }
      .hero-frame { min-height: 650px; }
      .hero-frame::after {
        background:
          linear-gradient(0deg, rgba(18,17,15,.97) 0%, rgba(18,17,15,.83) 53%, rgba(18,17,15,.22) 100%);
      }
      .hero-image {
        height: 49%;
        object-position: center;
      }
      .hero-content {
        width: 100%;
        min-height: 650px;
        padding: 290px 25px 38px;
        justify-content: flex-end;
      }
      .hero h1 { font-size: clamp(45px, 14vw, 64px); }
      .hero-lead { font-size: 15px; }
      .hero-note { display: none; }

      .contact-strip {
        grid-template-columns: 1fr;
        margin-bottom: 60px;
      }
      .contact-item,
      .contact-item:nth-child(2) {
        min-height: 92px;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .contact-item:last-child { border-bottom: 0; }

      .form-card { padding: 24px 20px; }
      .form-top { display: block; }
      .secure-badge { width: fit-content; margin-top: 16px; }

      .row { grid-template-columns: 1fr; }
      .submit-row { align-items: stretch; flex-direction: column; }
      .privacy { text-align: left; }

      .side { grid-template-columns: 1fr; }

      .services { grid-template-columns: 1fr; }
      .service {
        min-height: auto;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .service:last-child { border-bottom: 0; }
      .service h3 { margin-top: 25px; }

      .footer-grid { grid-template-columns: 1fr; gap: 28px; }
      .footer-bottom { flex-direction: column; }
    }

    /* —— Enhancements —— */
    .skip-link {
      position: absolute;
      left: -9999px;
      top: 0;
      z-index: 100;
      padding: 10px 16px;
      background: var(--ink);
      color: #fff;
      font-weight: 800;
      font-size: 13px;
      text-decoration: none;
    }
    .skip-link:focus {
      left: 12px;
      top: 12px;
    }
    a:focus-visible,
    button:focus-visible,
    input:focus-visible,
    select:focus-visible,
    textarea:focus-visible,
    summary:focus-visible {
      outline: 3px solid var(--stone);
      outline-offset: 2px;
    }
    .status-strip {
      display: none;
      border-bottom: 1px solid var(--line);
      background: #f3eee4;
      color: var(--ink);
      font-size: 13px;
    }
    .status-strip.is-visible { display: block; }
    .status-strip.is-degraded { background: #f7e8c8; }
    .status-strip.is-down { background: #f8e9e6; color: var(--error-ink); }
    .status-strip.is-maintenance { background: #e8eef8; }
    .status-strip-inner {
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .status-strip a { font-weight: 700; }
    .lang-switch {
      display: inline-flex;
      gap: 2px;
      padding: 3px;
      border: 1px solid var(--line);
      background: var(--surface-2);
    }
    .lang-switch button {
      min-width: 36px;
      height: 34px;
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: 11px;
      font-weight: 800;
    }
    .lang-switch button[aria-pressed="true"] {
      background: var(--ink);
      color: var(--surface);
    }
    .hours-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      background: var(--surface-2);
      font-size: 12px;
      font-weight: 700;
    }
    .hours-pill .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #9a9a9a;
    }
    .hours-pill.is-open .dot { background: #2f8f4e; }
    .hours-pill.is-closed .dot { background: #b4554a; }
    .ticket-lookup {
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
    }
    .ticket-lookup-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .ticket-lookup input {
      flex: 1;
      min-width: 180px;
    }
    .ticket-lookup button {
      min-height: 48px;
      padding: 0 16px;
      border: 1px solid var(--ink);
      background: transparent;
      color: var(--ink);
      font: inherit;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
    }
    .success-panel {
      padding: 18px 18px 16px;
      margin: 0 0 22px;
      border-left: 3px solid var(--success-ink);
      background: var(--success);
      color: var(--success-ink);
    }
    .success-panel h4 {
      margin: 0 0 8px;
      font-family: Georgia, serif;
      font-size: 22px;
      font-weight: 400;
      color: inherit;
    }
    .success-panel ol {
      margin: 10px 0 0;
      padding-left: 18px;
      font-size: 14px;
      line-height: 1.55;
    }
    .success-panel .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 14px;
    }
    .success-panel .actions a {
      display: inline-flex;
      align-items: center;
      min-height: 40px;
      padding: 0 14px;
      background: var(--ink);
      color: #fff;
      text-decoration: none;
      font-size: 12px;
      font-weight: 800;
    }
    html[dir="rtl"] body { font-family: "Segoe UI", Tahoma, system-ui, sans-serif; }
    html[dir="rtl"] .kicker, html[dir="rtl"] .section-head .eyebrow,
    html[dir="rtl"] .contact-item .label { letter-spacing: 0.04em; }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="shell topbar-inner">
      <span>A-F Marbre — Fourniture & pose · Maroc</span>
      <span>Support : <a href="mailto:support@afmarbre.com">support@afmarbre.com</a> · <a href="https://wa.me/212661959239" target="_blank" rel="noopener">WhatsApp</a></span>
    </div>
  </div>

  <header>
    <div class="shell nav">
      <a class="brand" href="https://afmarbre.com/" aria-label="A-F Marbre — Accueil">
        <span class="brand-mark">A·F</span>
        <span class="brand-copy">
          <strong>A-F Marbre</strong>
          <small>Centre d’assistance</small>
        </span>
      </a>

      <nav class="nav-actions" aria-label="Navigation">
        <a class="nav-link" href="https://afmarbre.com/">Site principal</a>
        <a class="nav-link" href="https://status.afmarbre.com/" target="_blank" rel="noopener">État des services</a>
        <div class="theme-switch" role="group" aria-label="Thème du site">
          <button type="button" data-af-theme="system" aria-label="Thème système" title="Système">◐</button>
          <button type="button" data-af-theme="light" aria-label="Thème clair" title="Clair">☀</button>
          <button type="button" data-af-theme="dark" aria-label="Thème sombre" title="Sombre">☾</button>
        </div>
        <a class="nav-button" href="#demande">Ouvrir une demande</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="shell">
        <div class="hero-frame">
          <img class="hero-image" src="${BRAND_IMAGE}" alt="" fetchpriority="high">
          <div class="hero-content">
            <div class="kicker">Support A-F Marbre</div>
            <h1>Votre projet mérite un suivi précis.</h1>
            <p class="hero-lead">
              Devis, commande, livraison, pose, SAV ou entretien : notre équipe vous accompagne avec la même exigence que celle apportée à nos réalisations en pierre naturelle.
            </p>
            <div class="hero-actions">
              <a class="button button-light" href="https://chat.afmarbre.com/" target="_blank" rel="noopener">Parler avec notre chatbot</a>
              <a class="button button-ghost" href="#demande">Envoyer une demande</a>
              <a class="button button-ghost" href="https://wa.me/212661959239" target="_blank" rel="noopener">WhatsApp</a>
            </div>
          </div>
          <div class="hero-note">
            <span>Spécialiste pierre naturelle</span>
            <strong>Marbre · Granite<br>Onyx · Quartz</strong>
          </div>
        </div>
      </div>
    </section>

    <section class="shell">
      <div class="contact-strip" aria-label="Contacts rapides">
        <a class="contact-item" href="https://chat.afmarbre.com/" target="_blank" rel="noopener">
          <span class="label">Chatbot A-F Marbre</span>
          <strong>Discuter maintenant ↗</strong>
        </a>
        <a class="contact-item" href="tel:+212522969736">
          <span class="label">Téléphone</span>
          <strong>05 22 96 97 36</strong>
        </a>
        <a class="contact-item" href="https://wa.me/212661959239" target="_blank" rel="noopener">
          <span class="label">WhatsApp</span>
          <strong>06 61 95 92 39</strong>
        </a>
        <div class="contact-item">
          <span class="label" data-i18n="hours_label">Horaires</span>
          <strong data-i18n-html="hours_value">Lun. – Sam.<br>09:00 – 13:00 · 14:30 – 18:30</strong>
          <div id="hours-pill" class="hours-pill" aria-live="polite">
            <span class="dot" aria-hidden="true"></span>
            <span id="hours-pill-text">…</span>
          </div>
        </div>
        <a class="contact-item" href="https://maps.app.goo.gl/oAFFAobrUDsu5sAE6" target="_blank" rel="noopener">
          <span class="label">Showroom</span>
          <strong>Route Azemmour<br>Km24 Berahma</strong>
        </a>
      </div>
    </section>

    <section class="section" id="demande">
      <div class="shell">
        <div class="section-head">
          <span class="eyebrow">Assistance personnalisée</span>
          <h2>Parlez-nous de votre demande.</h2>
          <p>
            Indiquez votre référence de devis ou de commande si vous en avez une. Ces informations nous permettent d’identifier votre dossier plus facilement.
          </p>
        </div>

        <div class="support-layout">
          <section class="card form-card">
            <div class="form-top">
              <div>
                <h3>Formulaire support</h3>
                <p>Complétez les informations ci-dessous. Une référence unique sera créée après l’envoi.</p>
              </div>
              <div class="secure-badge">Protégé par Cloudflare</div>
            </div>

            ${
              successTicket
                ? `<div class="success-panel" role="status" aria-live="polite">
                    <h4 data-i18n="success_title">Demande bien reçue</h4>
                    <p data-i18n-html="success_ref">Référence : <strong>${escapeHtml(successTicket)}</strong></p>
                    <ol>
                      <li data-i18n="success_s1">Notre équipe répond en général sous 1 jour ouvré (souvent plus tôt).</li>
                      <li data-i18n="success_s2">La réponse part depuis support@afmarbre.com — vérifiez vos spams.</li>
                      <li data-i18n="success_s3">Pour des photos ou vidéos, envoyez-les sur WhatsApp en citant votre référence.</li>
                    </ol>
                    <div class="actions">
                      <a href="https://wa.me/212661959239?text=${encodeURIComponent("Bonjour, référence " + successTicket + " — ")}" target="_blank" rel="noopener" data-i18n="success_wa">WhatsApp avec ma référence</a>
                      <a href="mailto:support@afmarbre.com?subject=${encodeURIComponent("Suite ticket " + successTicket)}" data-i18n="success_mail">Écrire un e-mail</a>
                    </div>
                  </div>`
                : ""
            }
            ${errorMessage ? `<div class="notice error" role="alert" aria-live="assertive">${escapeHtml(errorMessage)}</div>` : ""}

            <form method="post" action="${SUBMIT_PATH}">
              <div class="row">
                <div>
                  <label for="name">Nom complet *</label>
                  <input id="name" name="name" type="text" minlength="2" maxlength="100" autocomplete="name" required>
                </div>
                <div>
                  <label for="email">Adresse e-mail *</label>
                  <input id="email" name="email" type="email" maxlength="254" autocomplete="email" required>
                </div>
              </div>

              <div class="row">
                <div>
                  <label for="phone">Téléphone</label>
                  <input id="phone" name="phone" type="tel" maxlength="40" autocomplete="tel" placeholder="+212 …">
                </div>
                <div>
                  <label for="reference">Réf. devis / commande</label>
                  <input id="reference" name="reference" type="text" maxlength="80" placeholder="Ex. DEV-2026-0012">
                </div>
              </div>

              <div class="row">
                <div>
                  <label for="type">Nature de la demande *</label>
                  <select id="type" name="type" required>
                    <option value="">Sélectionner…</option>
                    <option value="devis">Devis / commande</option>
                    <option value="livraison">Livraison & pose</option>
                    <option value="sav">SAV / qualité</option>
                    <option value="entretien">Entretien / cristallisation</option>
                    <option value="facture">Facture / paiement</option>
                    <option value="autre">Autre demande</option>
                  </select>
                </div>
                <div>
                  <label for="contact">Contact préféré *</label>
                  <select id="contact" name="contact" required>
                    <option value="email">E-mail</option>
                    <option value="telephone">Téléphone</option>
                    <option value="whatsapp">WhatsApp</option>
                  </select>
                </div>
              </div>

              <div>
                <label for="subject">Sujet *</label>
                <input id="subject" name="subject" type="text" minlength="3" maxlength="160" placeholder="Résumez votre demande en une phrase" required>
              </div>

              <div>
                <label for="message">Votre message *</label>
                <textarea id="message" name="message" minlength="10" maxlength="5000" required placeholder="Décrivez votre projet ou votre demande : matériau concerné, dimensions, ville, étape du projet et toute information utile."></textarea>
                <div class="field-help">Vous souhaitez joindre des photos ? Envoyez-les directement à notre équipe via WhatsApp.</div>
              </div>

              <div class="trap" aria-hidden="true">
                <label for="website">Site web</label>
                <input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
              </div>

              <div class="turnstile">
                ${
                  siteKey
                    ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTION}" data-theme="auto"></div>`
                    : `<span class="field-help">Turnstile doit être configuré avant la mise en production du formulaire.</span>`
                }
              </div>

              <div class="submit-row">
                <button type="submit">Transmettre ma demande</button>
                <p class="privacy">Vos informations sont utilisées uniquement pour le traitement de votre demande d’assistance.</p>
              </div>
            </form>
          </section>

          <aside class="side">
            <section class="card side-card chatbot-card">
              <span class="eyebrow">Réponse immédiate</span>
              <h3>Discutez avec notre chatbot.</h3>
              <p>Pour les questions rapides, notre assistant en ligne peut vous orienter avant de contacter l’équipe.</p>
              <a class="chat-button" href="https://chat.afmarbre.com/" target="_blank" rel="noopener">Ouvrir le chatbot ↗</a>
            </section>

            <section class="card side-card dark">
              <h3>Besoin d’un échange direct ?</h3>
              <p>Notre équipe est joignable du lundi au samedi pour vos demandes liées à vos projets en marbre et pierre naturelle.</p>

              <div class="support-list">
                <div class="support-line">
                  <span>E-mail support</span>
                  <a href="mailto:support@afmarbre.com">support@afmarbre.com</a>
                </div>
                <div class="support-line">
                  <span>Fixe</span>
                  <a href="tel:+212522969736">05 22 96 97 36</a>
                </div>
                <div class="support-line">
                  <span>Mobile / WhatsApp</span>
                  <a href="tel:+212661959239">06 61 95 92 39</a>
                </div>
                <div class="support-line">
                  <span>Showroom</span>
                  <a href="https://maps.app.goo.gl/oAFFAobrUDsu5sAE6" target="_blank" rel="noopener">Route Azemmour Km24 Berahma, Maroc</a>
                </div>
                <div class="support-line">
                  <span>Ouverture</span>
                  <strong>Lundi – Samedi<br>09:00 – 13:00 · 14:30 – 18:30</strong>
                </div>
              </div>

              <a class="wa-button" href="mailto:support@afmarbre.com?subject=Support%20A-F%20Marbre" data-i18n="email_btn">Envoyer un e-mail</a>
              <a class="wa-button" id="wa-prefill" href="https://wa.me/212661959239?text=Bonjour%2C%20je%20vous%20contacte%20depuis%20le%20support%20A-F%20Marbre." target="_blank" rel="noopener" data-i18n="wa_btn">Ouvrir WhatsApp</a>

              <div class="ticket-lookup">
                <label for="ticket-ref" data-i18n="ticket_label">Vous avez une référence AFM-… ?</label>
                <div class="ticket-lookup-row">
                  <input id="ticket-ref" name="ticket-ref" type="text" maxlength="32" placeholder="AFM-20260809-AB12CD34" autocomplete="off" spellcheck="false">
                  <button type="button" id="ticket-lookup-btn" data-i18n="ticket_btn">Suivre par e-mail</button>
                </div>
                <p class="field-help" data-i18n="ticket_help">Ouvre un e-mail prérempli vers support@afmarbre.com.</p>
              </div>
            </section>

            <section class="card side-card">
              <h3>Liens utiles</h3>
              <p>Accédez rapidement aux services A-F Marbre.</p>
              <div class="mini-links">
                <a href="https://chat.afmarbre.com/" target="_blank" rel="noopener">Chatbot A-F Marbre</a>
                <a href="mailto:support@afmarbre.com">E-mail support</a>
                <a href="https://afmarbre.com/" target="_blank" rel="noopener">Retour au site A-F Marbre</a>
                <a href="https://afmarbre.com/contact/" target="_blank" rel="noopener">Page contact</a>
                <a href="https://status.afmarbre.com/" target="_blank" rel="noopener">État des services</a>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell">
        <div class="section-head">
          <span class="eyebrow">Votre demande, au bon service</span>
          <h2>Un point de contact pour tout votre projet.</h2>
        </div>

        <div class="services">
          <article class="service">
            <span class="num">01</span>
            <h3>Avant le projet</h3>
            <p>Questions sur les matériaux, disponibilité, choix de pierre, devis et préparation d’une commande.</p>
          </article>
          <article class="service">
            <span class="num">02</span>
            <h3>Pendant la réalisation</h3>
            <p>Suivi de commande, coordination de livraison, informations liées à la pose et au chantier.</p>
          </article>
          <article class="service">
            <span class="num">03</span>
            <h3>Après la pose</h3>
            <p>SAV, conseils d’entretien, ponçage, nettoyage et cristallisation de vos surfaces en marbre.</p>
          </article>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="shell faq-grid">
        <div class="faq-title">
          <span class="eyebrow">Questions fréquentes</span>
          <h2>Avant de nous écrire.</h2>
          <p>Quelques informations utiles pour préparer votre demande et faciliter son traitement.</p>
        </div>

        <div class="faq">
          <details>
            <summary data-i18n="faq1_q">Quelles informations dois-je fournir pour une demande liée à un devis ?</summary>
            <p data-i18n="faq1_a">Indiquez le type de pierre, dimensions ou surfaces, la ville du projet, le type de réalisation et vos coordonnées. Si un devis existe déjà, ajoutez sa référence AFM-… ou DEV-…</p>
          </details>
          <details>
            <summary data-i18n="faq2_q">Comment envoyer des photos de mon marbre ou de mon chantier ?</summary>
            <p data-i18n="faq2_a">Le formulaire n’accepte pas de pièces jointes. Utilisez WhatsApp et précisez votre nom ou la référence de votre dossier.</p>
          </details>
          <details>
            <summary data-i18n="faq3_q">Quels sont les délais de pose habituels ?</summary>
            <p data-i18n="faq3_a">Ils dépendent du matériau, des quantités et de la charge chantier. Après validation du devis, l’équipe communique une fenêtre de pose indicative. Pour un suivi précis, ouvrez une demande « Livraison & pose » avec votre référence.</p>
          </details>
          <details>
            <summary data-i18n="faq4_q">Comment suivre l’état d’un devis ou d’une commande ?</summary>
            <p data-i18n="faq4_a">Utilisez le champ « Réf. devis / commande » dans le formulaire, ou l’outil « Vous avez une référence AFM-… ? » pour écrire à support@afmarbre.com avec la référence préremplie. Joignez toute information utile (date du devis, ville).</p>
          </details>
          <details>
            <summary data-i18n="faq5_q">Quels modes de paiement acceptez-vous ?</summary>
            <p data-i18n="faq5_a">Les modalités (virement, espèces en showroom, échéancier selon le projet) sont confirmées sur le devis. Pour une question de facture ou de paiement, choisissez « Facture / paiement » dans le formulaire.</p>
          </details>
          <details>
            <summary data-i18n="faq6_q">Puis-je demander de l’aide pour l’entretien ou la cristallisation ?</summary>
            <p data-i18n="faq6_a">Oui. Sélectionnez « Entretien / cristallisation », décrivez l’état de la surface, son emplacement et le résultat souhaité.</p>
          </details>
          <details>
            <summary data-i18n="faq7_q">Où se trouve le showroom A-F Marbre ?</summary>
            <p data-i18n="faq7_a">Route Azemmour Km24 Berahma, Maroc. Le lien Showroom ouvre Google Maps.</p>
          </details>
        </div>
      </div>
    </section>
  </main>

  <footer>
    <div class="shell">
      <div class="footer-grid">
        <div class="footer-brand">
          <strong>A-F Marbre</strong>
          <p>Fourniture et pose de marbre, granite, onyx, quartz et travertin. Une sélection de pierres naturelles pour des projets durables et élégants.</p>
        </div>
        <div class="footer-col">
          <span>Assistance</span>
          <a href="https://chat.afmarbre.com/" target="_blank" rel="noopener">Chatbot A-F Marbre</a>
          <a href="mailto:support@afmarbre.com">support@afmarbre.com</a>
          <a href="#demande">Ouvrir une demande</a>
          <a href="https://wa.me/212661959239" target="_blank" rel="noopener">WhatsApp</a>
          <a href="https://status.afmarbre.com/" target="_blank" rel="noopener">État des services</a>
        </div>
        <div class="footer-col">
          <span>A-F Marbre</span>
          <a href="https://afmarbre.com/" target="_blank" rel="noopener">Site principal</a>
          <a href="https://afmarbre.com/contact/" target="_blank" rel="noopener">Contact</a>
          <a href="https://maps.app.goo.gl/oAFFAobrUDsu5sAE6" target="_blank" rel="noopener">Showroom</a>
        </div>
      </div>
      <div class="footer-bottom">
        <span>© 2026 A-F Marbre — Centre d’assistance</span>
        <span>support.afmarbre.com</span>
      </div>
    </div>
  </footer>

  <script>
  (function () {
    var LANG_KEY = "afmarbre_support_lang";
    var strings = {
      fr: {
        skip: "Aller au formulaire",
        status_ok: "Tous les services A-F Marbre fonctionnent normalement.",
        status_degraded: "Certains services sont dégradés. Consultez la page de statut.",
        status_down: "Incident en cours sur une partie des services.",
        status_maint: "Maintenance planifiée en cours.",
        status_unknown: "Statut temporairement indisponible.",
        status_link: "Voir le statut",
        hours_open: "Ouvert maintenant (heure du Maroc)",
        hours_closed: "Fermé pour le moment (heure du Maroc)",
        ticket_label: "Vous avez une référence AFM-… ?",
        ticket_btn: "Suivre par e-mail",
        ticket_help: "Ouvre un e-mail prérempli vers support@afmarbre.com.",
        success_title: "Demande bien reçue",
        success_s1: "Notre équipe répond en général sous 1 jour ouvré (souvent plus tôt).",
        success_s2: "La réponse part depuis support@afmarbre.com — vérifiez vos spams.",
        success_s3: "Pour des photos ou vidéos, envoyez-les sur WhatsApp en citant votre référence.",
        success_wa: "WhatsApp avec ma référence",
        success_mail: "Écrire un e-mail"
      },
      en: {
        skip: "Skip to form",
        status_ok: "All A-F Marbre services are operating normally.",
        status_degraded: "Some services are degraded. Check the status page.",
        status_down: "An incident is affecting part of our services.",
        status_maint: "Scheduled maintenance is in progress.",
        status_unknown: "Status temporarily unavailable.",
        status_link: "View status",
        hours_open: "Open now (Morocco time)",
        hours_closed: "Currently closed (Morocco time)",
        ticket_label: "Have an AFM-… reference?",
        ticket_btn: "Follow up by email",
        ticket_help: "Opens a prefilled email to support@afmarbre.com.",
        success_title: "Request received",
        success_s1: "We usually reply within 1 business day (often sooner).",
        success_s2: "Replies come from support@afmarbre.com — check spam folders.",
        success_s3: "For photos or videos, send them on WhatsApp with your reference.",
        success_wa: "WhatsApp with my reference",
        success_mail: "Write an email"
      },
      ar: {
        skip: "الانتقال إلى النموذج",
        status_ok: "جميع خدمات A-F Marbre تعمل بشكل طبيعي.",
        status_degraded: "بعض الخدمات متأثرة. راجع صفحة الحالة.",
        status_down: "هناك عطل يؤثر على جزء من الخدمات.",
        status_maint: "صيانة مجدولة جارية.",
        status_unknown: "الحالة غير متاحة مؤقتاً.",
        status_link: "عرض الحالة",
        hours_open: "مفتوح الآن (توقيت المغرب)",
        hours_closed: "مغلق حالياً (توقيت المغرب)",
        ticket_label: "لديك مرجع AFM-…؟",
        ticket_btn: "متابعة عبر البريد",
        ticket_help: "يفتح بريداً جاهزاً إلى support@afmarbre.com.",
        success_title: "تم استلام طلبك",
        success_s1: "نرد عادة خلال يوم عمل واحد (وأحياناً أسرع).",
        success_s2: "الردود من support@afmarbre.com — تحقق من البريد غير المرغوب.",
        success_s3: "للصور أو الفيديو، أرسلها عبر واتساب مع رقم المرجع.",
        success_wa: "واتساب مع مرجعي",
        success_mail: "إرسال بريد"
      }
    };

    function metric(event) {
      try {
        fetch("/metrics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: event }),
          keepalive: true,
        }).catch(function () {});
      } catch (e) {}
    }

    function applyLang(lang) {
      if (!strings[lang]) lang = "fr";
      document.documentElement.lang = lang === "ar" ? "ar" : lang;
      document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
      var pack = strings[lang];
      document.querySelectorAll("[data-i18n]").forEach(function (el) {
        var k = el.getAttribute("data-i18n");
        if (pack[k]) el.textContent = pack[k];
      });
      document.querySelectorAll(".lang-switch button").forEach(function (btn) {
        var on = btn.getAttribute("data-lang") === lang;
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
      try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
      // refresh dynamic status/hours text
      updateHours();
      if (window.__lastStatus) renderStatus(window.__lastStatus, pack);
    }

    function updateHours() {
      var el = document.getElementById("hours-pill");
      var text = document.getElementById("hours-pill-text");
      if (!el || !text) return;
      var lang = document.documentElement.lang || "fr";
      if (lang === "ar") lang = "ar";
      else if (lang !== "en") lang = "fr";
      var pack = strings[lang] || strings.fr;
      var now;
      try {
        now = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Casablanca" }));
      } catch (e) {
        now = new Date();
      }
      var day = now.getDay(); // 0 Sun
      var mins = now.getHours() * 60 + now.getMinutes();
      var open = false;
      if (day >= 1 && day <= 6) {
        open = (mins >= 9 * 60 && mins < 13 * 60) || (mins >= 14 * 60 + 30 && mins < 18 * 60 + 30);
      }
      el.classList.toggle("is-open", open);
      el.classList.toggle("is-closed", !open);
      text.textContent = open ? pack.hours_open : pack.hours_closed;
    }

    function renderStatus(data, pack) {
      var strip = document.getElementById("status-strip");
      var label = document.getElementById("status-strip-text");
      if (!strip || !label) return;
      window.__lastStatus = data;
      pack = pack || strings[document.documentElement.lang] || strings.fr;
      var state = (data && data.state ? String(data.state) : "unknown").toLowerCase();
      strip.classList.remove("is-degraded", "is-down", "is-maintenance");
      var msg = pack.status_unknown;
      var show = false;
      if (state === "operational") {
        msg = pack.status_ok;
        show = false; // quiet when all good
      } else if (state === "degraded") {
        msg = pack.status_degraded;
        strip.classList.add("is-degraded");
        show = true;
      } else if (state === "downtime") {
        msg = pack.status_down;
        strip.classList.add("is-down");
        show = true;
      } else if (state === "maintenance") {
        msg = pack.status_maint;
        strip.classList.add("is-maintenance");
        show = true;
      }
      if (data && data.announcement) {
        msg = data.announcement;
        show = true;
      }
      label.textContent = msg;
      if (show) {
        strip.hidden = false;
        strip.classList.add("is-visible");
      } else {
        strip.hidden = true;
        strip.classList.remove("is-visible");
      }
    }

    function loadStatus() {
      fetch("/status-summary")
        .then(function (r) { return r.json(); })
        .then(function (data) { renderStatus(data); })
        .catch(function () { renderStatus({ state: "unknown" }); });
    }

    document.addEventListener("DOMContentLoaded", function () {
      metric("page_view");
      var lang = "fr";
      try { lang = localStorage.getItem(LANG_KEY) || "fr"; } catch (e) {}
      applyLang(lang);

      document.querySelectorAll(".lang-switch button").forEach(function (btn) {
        btn.addEventListener("click", function () {
          applyLang(btn.getAttribute("data-lang"));
          metric("lang_change");
        });
      });

      updateHours();
      setInterval(updateHours, 60000);
      loadStatus();
      setInterval(loadStatus, 120000);

      var ticketBtn = document.getElementById("ticket-lookup-btn");
      var ticketInput = document.getElementById("ticket-ref");
      if (ticketBtn && ticketInput) {
        ticketBtn.addEventListener("click", function () {
          var ref = (ticketInput.value || "").trim().toUpperCase();
          if (!ref) {
            ticketInput.focus();
            return;
          }
          metric("ticket_lookup");
          var subject = encodeURIComponent("Suivi dossier " + ref);
          var body = encodeURIComponent("Bonjour,\\n\\nJe souhaite un point sur mon dossier.\\nRéférence : " + ref + "\\n\\nMerci.");
          window.location.href = "mailto:support@afmarbre.com?subject=" + subject + "&body=" + body;
        });
      }

      // Turnstile failure is hard to hook; track form errors via notice presence
      if (document.querySelector(".notice.error")) metric("form_submit_error");
      if (document.querySelector(".success-panel")) metric("form_submit_ok");
    });
  })();
  </script>
</body>

}


function renderThemeScript() {
  return `(function(){
    var KEY="afmarbre_theme";
    var LEGACY="mac_theme";
    var MODES=["system","light","dark"];
    function valid(v){return MODES.indexOf(v)!==-1;}
    function cookieValue(){
      var match=document.cookie.match(new RegExp("(?:^|; )"+KEY.replace(/[.$?*|{}()\\[\\]\\\\/+^]/g,"\\\\$&")+"=([^;]*)"));
      return match?decodeURIComponent(match[1]):"";
    }
    function preference(){
      var c=cookieValue();
      if(valid(c)) return c;
      try {
        var local=localStorage.getItem(KEY)||localStorage.getItem(LEGACY)||"";
        if(valid(local)) return local;
      } catch(e) {}
      return "system";
    }
    function resolved(pref){
      return pref==="system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : (pref==="system"?"light":pref);
    }
    function paint(pref){
      var mode=resolved(pref);
      document.documentElement.dataset.theme=mode;
      document.documentElement.dataset.themePreference=pref;
      document.documentElement.style.colorScheme=mode;
      var meta=document.querySelector('meta[name="theme-color"]');
      if(meta) meta.setAttribute("content",mode==="dark"?"#12110f":"#f5f2ec");
      document.querySelectorAll("[data-af-theme]").forEach(function(btn){
        var active=btn.getAttribute("data-af-theme")===pref;
        btn.classList.toggle("active",active);
        btn.setAttribute("aria-pressed",active?"true":"false");
      });
    }
    function save(pref){
      if(!valid(pref)) return;
      try { localStorage.setItem(KEY,pref); } catch(e) {}
      document.cookie=KEY+"="+encodeURIComponent(pref)+"; Path=/; Domain=.afmarbre.com; Max-Age=31536000; SameSite=Lax; Secure";
      paint(pref);
      window.dispatchEvent(new CustomEvent("afmarbre-theme-change",{detail:{preference:pref,resolved:resolved(pref)}}));
    }
    window.AFMarbreTheme={get:preference,set:save,apply:paint};
    paint(preference());
    document.addEventListener("DOMContentLoaded",function(){
      paint(preference());
      document.querySelectorAll("[data-af-theme]").forEach(function(btn){
        btn.addEventListener("click",function(){save(btn.getAttribute("data-af-theme"));});
      });
    });
    if(window.matchMedia){
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){if(preference()==="system") paint("system");});
    }
  })();`;
}

function renderNotFound() {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#181715">
  <link rel="icon" href="https://afmarbre.com/favicon.ico" sizes="any">
  <title>Page introuvable | A-F Marbre Support</title>
  <style>
    body{margin:0;background:#f5f2ec;color:#181715;font-family:system-ui,sans-serif;min-height:100vh}
    .top{background:#181715;color:#e8e2d9;font-size:12px;padding:10px 20px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .top a{color:#fff}
    main{width:min(640px,calc(100% - 40px));margin:48px auto;padding:42px;background:#fffdf9;border:1px solid #dcd4c9;box-shadow:0 12px 35px rgba(32,27,21,.07)}
    small{text-transform:uppercase;letter-spacing:.16em;color:#7a5b38;font-weight:800}
    h1{font:400 48px/1.05 Georgia,serif;margin:12px 0 18px}
    p{color:#716b62;line-height:1.7}
    .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}
    .actions a{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;background:#181715;color:#fff;text-decoration:none;font-weight:700;font-size:13px}
    .actions a.secondary{background:transparent;color:#181715;border:1px solid #181715}
    a:focus-visible{outline:3px solid #a78255;outline-offset:2px}
  </style>
</head>
<body>
  <div class="top">
    <span>A-F Marbre — Centre d'assistance</span>
    <span><a href="mailto:support@afmarbre.com">support@afmarbre.com</a> · <a href="https://wa.me/212661959239" target="_blank" rel="noopener">WhatsApp</a></span>
  </div>
  <main>
    <small>Erreur 404</small>
    <h1>Page introuvable.</h1>
    <p>Cette adresse n'existe pas sur le centre d'assistance A-F Marbre. Vous pouvez revenir au formulaire, écrire à l'équipe ou ouvrir le chatbot.</p>
    <div class="actions">
      <a href="/">Retour au support</a>
      <a class="secondary" href="https://chat.afmarbre.com/" target="_blank" rel="noopener">Chatbot</a>
      <a class="secondary" href="https://wa.me/212661959239?text=Bonjour%2C%20je%20vous%20contacte%20depuis%20le%20support%20A-F%20Marbre." target="_blank" rel="noopener">WhatsApp</a>
      <a class="secondary" href="mailto:support@afmarbre.com">E-mail</a>
    </div>
  </main>
</body>
</html>`;
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "content-security-policy": [
        "default-src 'self'",
        "script-src 'self' https://challenges.cloudflare.com",
        "frame-src https://challenges.cloudflare.com",
        "connect-src 'self' https://challenges.cloudflare.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https://afmarbre.com",
        "font-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "upgrade-insecure-requests",
      ].join("; "),
    },
  });
}

function field(form, name) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function oneLine(value) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function cleanTicket(value) {
  return typeof value === "string" && /^AFM-\d{8}-[A-F0-9]{8}$/.test(value)
    ? value
    : "";
}

function makeTicketId() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  return `AFM-${date}-${suffix}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function emailRow(label, value) {
  return `<tr>
    <td style="width:185px;border-bottom:1px solid #ece7df;color:#756e65"><strong>${escapeHtml(label)}</strong></td>
    <td style="border-bottom:1px solid #ece7df">${escapeHtml(value)}</td>
  </tr>`;
}
