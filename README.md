# A-F Marbre Support — Cloudflare Worker

Ready-to-deploy support page for:

- `https://afmarbre.com/support`
- form endpoint: `https://afmarbre.com/support/submit`

The existing WordPress site remains the origin. The Worker route is limited to `afmarbre.com/support*`.

## What is included

- Responsive French support page
- A-F Marbre contact details
- WhatsApp and phone shortcuts
- Support categories for devis, livraison/pose, SAV, entretien and facturation
- Cloudflare Turnstile anti-spam validation
- Server-side validation and escaping
- Honeypot field
- Ticket reference generation
- Cloudflare Email Service sending through an `EMAIL` binding
- Security headers / CSP
- Link to `status.afmarbre.com`

## 1. Configure Cloudflare Email Service

In Cloudflare, onboard `afmarbre.com` as a sending domain for Email Service.

Then verify the inbox that should receive support requests.

Edit `wrangler.jsonc`:

```jsonc
"SUPPORT_TO": "YOUR_VERIFIED_INBOX",
"SUPPORT_FROM": "support@afmarbre.com"
```

`SUPPORT_FROM` must use a domain that Cloudflare Email Service has accepted for sending.

The Worker intentionally sends only to your support inbox and uses the customer's email as `Reply-To`. It does **not** send an automatic reply to arbitrary visitor addresses.

## 2. Configure Turnstile

Create a Turnstile widget for:

- `afmarbre.com`

Put its public site key in `wrangler.jsonc`:

```jsonc
"TURNSTILE_SITE_KEY": "YOUR_SITE_KEY"
```

Store the secret as a Worker secret:

```bash
npx wrangler@latest secret put TURNSTILE_SECRET
```

Paste the Turnstile secret when prompted.

Do not put the secret in `wrangler.jsonc`.

## 3. Deploy

From this folder:

```bash
npx wrangler@latest deploy
```

The configured Worker Route is:

```text
afmarbre.com/support*
```

Cloudflare Routes require the domain/zone to be active in Cloudflare and the hostname to be proxied through Cloudflare.

## 4. Test

Open:

```text
https://afmarbre.com/support
```

Submit a test request and confirm:

1. Turnstile completes.
2. The browser redirects back to `/support`.
3. A ticket reference like `AFM-20260809-AB12CD34` is shown.
4. Your verified support inbox receives the message.
5. Replying to that email replies directly to the customer.

## Optional: stricter email binding

Once your final support destination is known, you can restrict the binding itself:

```jsonc
"send_email": [
  {
    "name": "EMAIL",
    "destination_address": "YOUR_VERIFIED_INBOX",
    "allowed_sender_addresses": ["support@afmarbre.com"]
  }
]
```

This limits what the Worker can send even if code is changed later.

## Notes

- The form deliberately does not accept file uploads. Customers are directed to WhatsApp for photos, which keeps the Worker simpler and reduces abuse risk.
- If you want a real ticket dashboard/history instead of email-only support, add D1 storage later.
- The showroom Google Maps button in the Worker currently opens a generic Google Maps host. Replace it with your exact share link if desired.
