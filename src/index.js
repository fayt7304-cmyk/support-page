const SUPPORT_PATH = "/support";
const SUBMIT_PATH = "/support/submit";
const TURNSTILE_ACTION = "support_request";

const REQUEST_TYPES = {
  devis: "Devis / commande",
  livraison: "Livraison & pose",
  sav: "SAV / qualité",
  entretien: "Entretien du marbre",
  facture: "Facture / paiement",
  autre: "Autre demande",
};

const CONTACT_METHODS = {
  email: "E-mail",
  telephone: "Téléphone",
  whatsapp: "WhatsApp",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if ((url.pathname === SUPPORT_PATH || url.pathname === `${SUPPORT_PATH}/`) &&
        (request.method === "GET" || request.method === "HEAD")) {
      const success = url.searchParams.get("success") === "1";
      const ticket = cleanTicket(url.searchParams.get("ticket"));
      const html = renderPage(env, {
        successMessage: success && ticket
          ? `Votre demande a bien été envoyée. Référence : ${ticket}`
          : "",
      });
      return htmlResponse(request.method === "HEAD" ? "" : html, 200);
    }

    if (url.pathname === SUBMIT_PATH && request.method === "POST") {
      return handleSupportRequest(request, env);
    }

    if (url.pathname.startsWith(SUPPORT_PATH)) {
      // This Worker is intended to sit on afmarbre.com/support*.
      // Pass anything else under that broad route back to the WordPress origin.
      return fetch(request);
    }

    return fetch(request);
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
      renderPage(env, { errorMessage: "Formulaire invalide. Veuillez réessayer." }),
      400
    );
  }

  // Honeypot: silently accept obvious bot submissions without sending mail.
  if (field(form, "website")) {
    return Response.redirect(`${new URL(request.url).origin}${SUPPORT_PATH}?success=1&ticket=AFM-RECU`, 303);
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
          "Le formulaire est en cours de configuration. Vous pouvez nous contacter par WhatsApp ou téléphone.",
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
          "La vérification anti-spam a échoué ou a expiré. Veuillez actualiser la page et réessayer.",
      }),
      403
    );
  }

  if (
    !env.EMAIL ||
    !env.SUPPORT_TO ||
    env.SUPPORT_TO.includes("replace-me") ||
    !env.SUPPORT_FROM
  ) {
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

  const text = [
    `Nouvelle demande support A-F Marbre`,
    ``,
    `Référence: ${ticket}`,
    `Type: ${typeLabel}`,
    `Nom: ${data.name}`,
    `E-mail: ${data.email}`,
    `Téléphone: ${data.phone || "Non renseigné"}`,
    `Préférence de contact: ${contactLabel}`,
    `Référence devis/commande: ${data.reference || "Non renseignée"}`,
    `Sujet: ${data.subject}`,
    ``,
    `Message:`,
    data.message,
    ``,
    `IP: ${request.headers.get("CF-Connecting-IP") || "Non disponible"}`,
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#202020">
      <h2 style="margin-bottom:6px">Nouvelle demande support A-F Marbre</h2>
      <p style="margin-top:0;color:#666">Référence <strong>${escapeHtml(ticket)}</strong></p>
      <table cellpadding="8" cellspacing="0" style="width:100%;border-collapse:collapse">
        ${emailRow("Type", typeLabel)}
        ${emailRow("Nom", data.name)}
        ${emailRow("E-mail", data.email)}
        ${emailRow("Téléphone", data.phone || "Non renseigné")}
        ${emailRow("Préférence", contactLabel)}
        ${emailRow("Réf. devis/commande", data.reference || "Non renseignée")}
        ${emailRow("Sujet", data.subject)}
      </table>
      <div style="margin-top:18px;padding:16px;background:#f6f3ed;border-radius:10px">
        <strong>Message</strong>
        <p style="white-space:pre-wrap">${escapeHtml(data.message)}</p>
      </div>
    </div>`;

  try {
    await env.EMAIL.send({
      to: env.SUPPORT_TO,
      from: { email: env.SUPPORT_FROM, name: "A-F Marbre Support" },
      replyTo: { email: data.email, name: data.name },
      subject: `[A-F Marbre] ${ticket} — ${typeLabel} — ${data.subject}`,
      text,
      html,
    });
  } catch (error) {
    console.error("Support email failed:", error?.code, error?.message);
    return htmlResponse(
      renderPage(env, {
        errorMessage:
          "Nous n’avons pas pu envoyer votre demande pour le moment. Merci d’utiliser WhatsApp ou de réessayer plus tard.",
      }),
      502
    );
  }

  const redirectUrl = new URL(SUPPORT_PATH, request.url);
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
      .map((v) => v.trim().toLowerCase())
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
  if (data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return "Veuillez saisir une adresse e-mail valide.";
  }
  if (data.phone.length > 40) {
    return "Le numéro de téléphone est trop long.";
  }
  if (data.reference.length > 80) {
    return "La référence devis/commande est trop longue.";
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

function renderPage(env, { successMessage = "", errorMessage = "" } = {}) {
  const siteKey =
    env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SITE_KEY.startsWith("REPLACE_")
      ? env.TURNSTILE_SITE_KEY
      : "";

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Support | A-F Marbre</title>
  <meta name="description" content="Centre d’assistance A-F Marbre : devis, commande, livraison, pose, SAV, entretien et facturation.">
  <meta name="robots" content="index,follow">
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    :root{
      --ink:#171717;
      --muted:#6b675f;
      --paper:#f6f3ed;
      --surface:#ffffff;
      --line:#ddd7cc;
      --accent:#9b7747;
      --accent-dark:#76562f;
      --soft:#eee8dc;
      --success:#e8f3e9;
      --success-ink:#285b31;
      --error:#fae9e7;
      --error-ink:#862f26;
      --radius:22px;
      --shadow:0 18px 50px rgba(26,22,17,.08);
    }
    *{box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{
      margin:0;
      color:var(--ink);
      background:
        radial-gradient(circle at 20% 10%,rgba(155,119,71,.09),transparent 24rem),
        radial-gradient(circle at 80% 35%,rgba(120,120,120,.07),transparent 22rem),
        linear-gradient(135deg,#faf8f4,#f1eee8);
      font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      line-height:1.55;
    }
    a{color:inherit}
    .wrap{width:min(1160px,calc(100% - 32px));margin:auto}
    header{
      position:sticky;top:0;z-index:20;
      background:rgba(250,248,244,.88);
      backdrop-filter:blur(14px);
      border-bottom:1px solid rgba(120,110,95,.14);
    }
    .nav{height:76px;display:flex;align-items:center;justify-content:space-between;gap:18px}
    .brand{display:flex;align-items:center;gap:12px;text-decoration:none}
    .mark{
      width:42px;height:42px;border:1px solid var(--ink);border-radius:50%;
      display:grid;place-items:center;font-family:Georgia,serif;font-size:18px;letter-spacing:-1px;
      background:linear-gradient(145deg,#fff,#e9e2d6);
    }
    .brand strong{display:block;font-family:Georgia,serif;font-size:20px;letter-spacing:.02em}
    .brand small{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.14em}
    .navlinks{display:flex;align-items:center;gap:12px}
    .navlinks a{font-size:14px;text-decoration:none;padding:10px 12px;border-radius:999px}
    .navlinks a:hover{background:var(--soft)}
    .status-link{border:1px solid var(--line)}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4f8b59;margin-right:7px}
    .hero{padding:74px 0 42px}
    .eyebrow{color:var(--accent-dark);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.18em}
    h1{
      max-width:780px;margin:12px 0 18px;
      font-family:Georgia,"Times New Roman",serif;
      font-size:clamp(42px,7vw,76px);line-height:.98;font-weight:500;letter-spacing:-.045em;
    }
    .lead{max-width:710px;color:var(--muted);font-size:18px}
    .quick-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:30px 0 0}
    .quick{
      min-height:145px;padding:22px;border:1px solid var(--line);border-radius:18px;
      background:rgba(255,255,255,.7);text-decoration:none;transition:.2s ease;
    }
    .quick:hover{transform:translateY(-2px);box-shadow:var(--shadow)}
    .quick .icon{font-size:22px}
    .quick strong{display:block;margin-top:20px;font-size:16px}
    .quick span{display:block;color:var(--muted);font-size:13px;margin-top:3px}
    main{padding:18px 0 80px}
    .layout{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(300px,.75fr);gap:24px;align-items:start}
    .card{background:rgba(255,255,255,.91);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
    .form-card{padding:34px}
    .form-card h2,.side-card h2{font-family:Georgia,serif;font-size:30px;font-weight:500;margin:0 0 8px}
    .form-card .intro{margin:0 0 26px;color:var(--muted)}
    .notice{padding:14px 16px;border-radius:14px;margin:0 0 22px;font-size:14px}
    .notice.success{background:var(--success);color:var(--success-ink)}
    .notice.error{background:var(--error);color:var(--error-ink)}
    form{display:grid;gap:17px}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:15px}
    label{display:block;font-size:13px;font-weight:750;margin-bottom:7px}
    input,select,textarea{
      width:100%;border:1px solid var(--line);border-radius:12px;background:#fff;
      color:var(--ink);font:inherit;padding:13px 14px;outline:none;
      transition:border-color .15s,box-shadow .15s;
    }
    input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(155,119,71,.13)}
    textarea{min-height:150px;resize:vertical}
    .help{font-size:12px;color:var(--muted);margin-top:6px}
    .trap{position:absolute;left:-9999px;opacity:0;pointer-events:none}
    .turnstile-box{min-height:68px;display:flex;align-items:center}
    button{
      border:0;border-radius:999px;background:var(--ink);color:#fff;
      padding:14px 22px;font:inherit;font-weight:800;cursor:pointer;justify-self:start;
    }
    button:hover{background:#2c2b29}
    .privacy{font-size:12px;color:var(--muted);margin:0}
    .side{display:grid;gap:18px}
    .side-card{padding:25px}
    .contact-list{display:grid;gap:15px;margin-top:20px}
    .contact{padding-top:14px;border-top:1px solid var(--line)}
    .contact:first-child{border-top:0;padding-top:0}
    .contact b{display:block;font-size:13px;margin-bottom:3px}
    .contact span,.contact a{font-size:14px;color:var(--muted);text-decoration:none}
    .contact a:hover{text-decoration:underline}
    .whatsapp{
      display:flex;align-items:center;justify-content:center;text-align:center;
      margin-top:20px;padding:13px 16px;border-radius:999px;background:var(--soft);
      text-decoration:none;font-weight:800;font-size:14px;
    }
    .topics{display:grid;gap:10px;margin-top:18px}
    .topic{display:flex;gap:10px;align-items:flex-start;font-size:14px;color:var(--muted)}
    .topic i{width:22px;height:22px;border-radius:50%;background:var(--soft);display:grid;place-items:center;color:var(--accent-dark);font-style:normal;font-size:12px;flex:0 0 auto}
    footer{border-top:1px solid var(--line);padding:28px 0 45px;color:var(--muted);font-size:13px}
    footer .wrap{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap}
    @media (max-width:850px){
      .layout{grid-template-columns:1fr}
      .quick-grid{grid-template-columns:1fr}
      .quick{min-height:unset}
      .navlinks a:not(.status-link){display:none}
    }
    @media (max-width:620px){
      .hero{padding-top:48px}
      .row{grid-template-columns:1fr}
      .form-card{padding:22px}
      .side-card{padding:22px}
      h1{font-size:46px}
    }
  </style>
</head>
<body>
<header>
  <div class="wrap nav">
    <a class="brand" href="https://afmarbre.com/">
      <span class="mark">A·F</span>
      <span><strong>A-F Marbre</strong><small>L’art du marbre</small></span>
    </a>
    <nav class="navlinks" aria-label="Navigation principale">
      <a href="https://afmarbre.com/">Accueil</a>
      <a href="https://afmarbre.com/contact/">Contact</a>
      <a class="status-link" href="https://status.afmarbre.com/" target="_blank" rel="noopener"><span class="dot"></span>État des services</a>
    </nav>
  </div>
</header>

<section class="hero">
  <div class="wrap">
    <div class="eyebrow">Centre d’assistance</div>
    <h1>Comment pouvons-nous vous aider&nbsp;?</h1>
    <p class="lead">Une question sur un devis, une commande, la pose, l’entretien ou le service après-vente ? Envoyez votre demande à l’équipe A-F Marbre.</p>

    <div class="quick-grid">
      <a class="quick" href="#formulaire"><span class="icon">✦</span><strong>Ouvrir une demande</strong><span>Décrivez votre besoin et recevez une référence.</span></a>
      <a class="quick" href="https://wa.me/212661959239" target="_blank" rel="noopener"><span class="icon">◌</span><strong>WhatsApp</strong><span>06 61 95 92 39</span></a>
      <a class="quick" href="tel:+212522969736"><span class="icon">☎</span><strong>Nous appeler</strong><span>05 22 96 97 36</span></a>
    </div>
  </div>
</section>

<main>
  <div class="wrap layout">
    <section class="card form-card" id="formulaire">
      <h2>Envoyer une demande</h2>
      <p class="intro">Plus votre demande est précise, plus notre équipe pourra vous répondre rapidement.</p>

      ${successMessage ? `<div class="notice success" role="status">${escapeHtml(successMessage)}</div>` : ""}
      ${errorMessage ? `<div class="notice error" role="alert">${escapeHtml(errorMessage)}</div>` : ""}

      <form method="post" action="${SUBMIT_PATH}">
        <div class="row">
          <div>
            <label for="name">Nom complet *</label>
            <input id="name" name="name" type="text" minlength="2" maxlength="100" autocomplete="name" required>
          </div>
          <div>
            <label for="email">E-mail *</label>
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
            <label for="type">Type de demande *</label>
            <select id="type" name="type" required>
              <option value="">Choisir…</option>
              <option value="devis">Devis / commande</option>
              <option value="livraison">Livraison & pose</option>
              <option value="sav">SAV / qualité</option>
              <option value="entretien">Entretien du marbre</option>
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
          <input id="subject" name="subject" type="text" minlength="3" maxlength="160" required>
        </div>

        <div>
          <label for="message">Votre message *</label>
          <textarea id="message" name="message" minlength="10" maxlength="5000" required placeholder="Décrivez votre demande, le matériau concerné, la ville du projet et toute information utile."></textarea>
          <div class="help">Pour des photos, vous pouvez aussi nous écrire sur WhatsApp.</div>
        </div>

        <div class="trap" aria-hidden="true">
          <label for="website">Site web</label>
          <input id="website" name="website" type="text" tabindex="-1" autocomplete="off">
        </div>

        <div class="turnstile-box">
          ${siteKey
            ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTION}" data-theme="light"></div>`
            : `<span class="help">Turnstile doit être configuré avant la mise en production du formulaire.</span>`
          }
        </div>

        <button type="submit">Envoyer ma demande</button>
        <p class="privacy">Les informations envoyées via ce formulaire servent uniquement à traiter votre demande d’assistance.</p>
      </form>
    </section>

    <aside class="side">
      <section class="card side-card">
        <h2>Contact direct</h2>
        <div class="contact-list">
          <div class="contact">
            <b>Showroom</b>
            <a href="https://maps.app.goo.gl/oAFFAobrUDsu5sAE6" target="_blank" rel="noopener">Route Azemmour Km24 Berahma, Maroc</a>
          </div>
          <div class="contact">
            <b>Téléphone fixe</b>
            <a href="tel:+212522969736">05 22 96 97 36</a>
          </div>
          <div class="contact">
            <b>Mobile / WhatsApp</b>
            <a href="tel:+212661959239">06 61 95 92 39</a>
          </div>
          <div class="contact">
            <b>Horaires</b>
            <span>Lundi – Samedi<br>09:00 – 13:00<br>14:30 – 18:30</span>
          </div>
        </div>
        <a class="whatsapp" href="https://wa.me/212661959239" target="_blank" rel="noopener">Contacter sur WhatsApp</a>
      </section>

      <section class="card side-card">
        <h2>Nous pouvons vous aider pour</h2>
        <div class="topics">
          <div class="topic"><i>1</i><span>Suivi d’un devis ou d’une commande</span></div>
          <div class="topic"><i>2</i><span>Questions sur la livraison ou la pose</span></div>
          <div class="topic"><i>3</i><span>SAV, qualité ou finition</span></div>
          <div class="topic"><i>4</i><span>Nettoyage, ponçage et cristallisation</span></div>
          <div class="topic"><i>5</i><span>Facturation et informations administratives</span></div>
        </div>
      </section>
    </aside>
  </div>
</main>

<footer>
  <div class="wrap">
    <span>© 2026 A-F Marbre — Fourniture & pose</span>
    <span>Marbre · Granite · Onyx · Quartz · Travertin</span>
  </div>
</footer>
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
        "img-src 'self' data:",
        "font-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
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
    <td style="width:180px;border-bottom:1px solid #eee;color:#666"><strong>${escapeHtml(label)}</strong></td>
    <td style="border-bottom:1px solid #eee">${escapeHtml(value)}</td>
  </tr>`;
}
