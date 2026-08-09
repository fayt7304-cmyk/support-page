# A-F Marbre Support — Cloudflare Worker

Premium support portal for:

**https://support.afmarbre.com/**

This version uses a **Cloudflare Worker Custom Domain**. The Worker is the origin for the complete `support.afmarbre.com` hostname, while `afmarbre.com` remains your existing WordPress site.

## What changed in this version

- Moved from `afmarbre.com/support` to `support.afmarbre.com`
- Changed the Wrangler configuration from a Worker Route to a Custom Domain
- Redesigned the page around A-F Marbre's premium marble / natural-stone visual language
- Uses an A-F Marbre site image for the hero
- Uses the main afmarbre.com favicon/site icon for browser tabs and Apple home-screen bookmarks
- Uses the exact showroom map link from the current contact page
- Added polished desktop + mobile layouts
- Includes a prominent link to the A-F Marbre chatbot at `https://chat.afmarbre.com/`
- Adds Light / Dark / System theme controls to the support portal
- Shares the selected theme across `*.afmarbre.com` with the first-party `afmarbre_theme` cookie
- Added support workflow sections and FAQ
- Added `/health`
- Keeps Turnstile, form validation, honeypot protection and Cloudflare Email Service
- Generates unique support references
- Keeps customer e-mail as `Reply-To`

## 1. Important DNS note

The Wrangler config contains:

```jsonc
"routes": [
  {
    "pattern": "support.afmarbre.com",
    "custom_domain": true
  }
]
```

Cloudflare will create and manage the DNS entry and TLS certificate for the Custom Domain.

If `support.afmarbre.com` already has an existing CNAME record, remove that CNAME before adding/deploying the Worker Custom Domain. Do **not** point a separate CNAME at a `workers.dev` URL.

## 2. Resend via api.afmarbre.com

This support Worker **does not use Cloudflare Email Service**. It calls the existing API Worker through a Cloudflare Service Binding.

It sends the validated support ticket server-to-server to:

```text
https://api.afmarbre.com/api/support
```

That endpoint lives in the existing A-F Marbre API Worker (`mistral-agent-chat`) and uses the Resend API key already configured there.

The destination is:

```text
fayt7304@gmail.com
```

The Resend message uses the customer's submitted email as `reply_to`, so pressing **Reply** in Gmail addresses the customer directly.

### Worker-to-Worker connection

No shared API token is needed in this version.

`afmarbre-support` has a Cloudflare Service Binding named `AFMARBRE_API` pointing directly to the existing Worker named `mistral-agent-chat`. The support form therefore does not depend on public DNS, CORS, or an HTTPS call to `api.afmarbre.com`.


## 3. Configure Turnstile

Create a Turnstile widget and add:

```text
support.afmarbre.com
```

as an allowed hostname.

Copy the public site key into `wrangler.jsonc`:

```jsonc
"TURNSTILE_SITE_KEY": "0x4AAAAAAELV-6t0f-Bafy_y"
```

Store the Turnstile secret as a Worker secret:

```bash
npx wrangler@latest secret put TURNSTILE_SECRET
```

Paste the secret when Wrangler asks for it.

Never put the secret directly in `wrangler.jsonc`.

## 4. Deploy

From this project directory:

```bash
npm install
npm run deploy
```

or without installing dependencies permanently:

```bash
npx wrangler@latest deploy
```

When the deployment finishes, open:

```text
https://support.afmarbre.com/
```

## 5. Test the form

Confirm that:

1. `https://support.afmarbre.com/` loads over HTTPS.
2. The A-F Marbre hero image loads.
3. Turnstile completes successfully.
4. A test submission redirects back to `/`.
5. A reference similar to `AFM-20260809-AB12CD34` appears.
6. Your configured support inbox receives the ticket.
7. Pressing Reply addresses the customer's e-mail.

Health endpoint:

```text
https://support.afmarbre.com/health
```

It should return:

```json
{"ok":true,"service":"afmarbre-support"}
```

## 6. Email architecture

Email delivery is handled by Resend in `api.afmarbre.com`; there is no `send_email` binding in this Worker.

## Project structure

```text
afmarbre-support-worker/
├── src/
│   └── index.js
├── wrangler.jsonc
├── package.json
├── .gitignore
└── README.md
```

## Notes

The support form does not accept file uploads. Customers who need to send photos/videos are directed to WhatsApp. This keeps the public form lightweight and reduces abuse risk.

The hero image is loaded from the existing A-F Marbre WordPress media library. If you later change the WordPress image URL, update `BRAND_IMAGE` near the top of `src/index.js`.


## Support Gmail / reply flow

This build uses `support@afmarbre.com` as the public support inbox and the primary destination for support-form tickets.

The API sends each ticket to `support@afmarbre.com`, privately BCCs `fayt7304@gmail.com`, and keeps the visitor's submitted address as the message `Reply-To`.

Flow:

1. Customer submits the support form.
2. The main ticket arrives at `support@afmarbre.com`.
3. A private BCC copy is also delivered to `fayt7304@gmail.com`.
4. The customer never sees the Gmail copy address.
5. Reply from the `support@afmarbre.com` mailbox to keep all customer-facing mail on the A-F Marbre domain.

Only `support@afmarbre.com` is shown publicly on the support page.

Before production, verify `fayt7304@gmail.com` as a Cloudflare Email Service / Email Routing destination.
