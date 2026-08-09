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

## 2. Configure Cloudflare Email Service

Onboard the sending domain you want to use with Cloudflare Email Service.

Then verify the inbox that should receive support tickets.

Edit `wrangler.jsonc`:

```jsonc
"SUPPORT_TO": "YOUR_VERIFIED_SUPPORT_INBOX",
"SUPPORT_FROM": "support@afmarbre.com"
```

The Worker sends support submissions only to your configured inbox. The visitor's e-mail is used as the `Reply-To`, so pressing Reply in your inbox answers the customer.

## 3. Configure Turnstile

Create a Turnstile widget and add:

```text
support.afmarbre.com
```

as an allowed hostname.

Copy the public site key into `wrangler.jsonc`:

```jsonc
"TURNSTILE_SITE_KEY": "YOUR_SITE_KEY"
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

## 6. Optional hardening after you know the final inbox

You can restrict the Cloudflare e-mail binding itself:

```jsonc
"send_email": [
  {
    "name": "EMAIL",
    "destination_address": "YOUR_VERIFIED_SUPPORT_INBOX",
    "allowed_sender_addresses": ["support@afmarbre.com"]
  }
]
```

This is a useful defense-in-depth measure.

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
