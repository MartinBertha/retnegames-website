# retne.games website + contact form

This setup uses:

- Cloudflare Worker + Static Assets
- Cloudflare Turnstile for bot protection
- Cloudflare Email Service for outbound email
- Cloudflare Worker Rate Limiting for abuse control
- No private keys or secrets in frontend code

## Files

- `public/index.html` — page structure
- `public/styles.css` — minimal site styling
- `public/app.js` — form submission + dynamic copyright year
- `src/index.js` — API endpoint, Turnstile validation and email sending
- `wrangler.jsonc` — Worker, Email Service and rate-limit configuration

## Required Cloudflare setup

1. In Cloudflare, onboard `retne.games` under Email Service > Email Sending.
2. Make sure `hello@retne.games` is a verified destination address.
3. Create a Turnstile widget for `retne.games`.
   - Recommended mode: Managed
   - Hostname: `retne.games`
   - Optional during development: `localhost`
4. Put the Turnstile sitekey into `public/index.html`, replacing:
   `YOUR_TURNSTILE_SITE_KEY`
5. Add the Turnstile secret to the Worker. Do not put it in source control:
   `npx wrangler secret put TURNSTILE_SECRET`
6. Deploy:
   `npx wrangler deploy`

## Important

The Turnstile sitekey is public and belongs in the HTML. The Turnstile secret is private and must exist only as a Worker secret.

The Email Service binding is also not a frontend credential. It is a Worker capability granted by Cloudflare.

The contact endpoint is additionally protected by:

- exact production Origin checking
- Turnstile server-side validation
- a hidden honeypot field
- strict input lengths
- email format validation
- 3 requests/minute/source-IP rate limiting
- no HTML rendering of user input in the email body
- security response headers and a restrictive Content Security Policy

## Local development

For local development, create `.dev.vars` containing:

TURNSTILE_SECRET=your-development-secret

Do not commit `.dev.vars`.

The provided Wrangler configuration uses a remote Email Service binding, so local `wrangler dev` can send real email. Use this carefully and preferably test with your own address.

Run:

`npx wrangler dev`

Then open the local URL shown by Wrangler.

## Existing project warning

If you already have a working `wrangler.jsonc`, merge the `assets`, `send_email`, `ratelimits`, and `secrets` sections into your existing configuration rather than blindly replacing unrelated configuration.

Also keep your existing domain/custom-domain configuration intact.

## Production checklist

- [ ] Turnstile widget created for `retne.games`
- [ ] Production sitekey inserted into `public/index.html`
- [ ] Production secret stored with `wrangler secret put TURNSTILE_SECRET`
- [ ] `hello@retne.games` verified as a destination address
- [ ] `retne.games` onboarded for Email Service sending
- [ ] SPF/DKIM/DMARC records created by Cloudflare Email Service
- [ ] Deploy with `npx wrangler deploy`
- [ ] Test successful submission
- [ ] Test invalid Turnstile submission
- [ ] Test repeated submissions/rate limiting
- [ ] Confirm received email has the visitor's address as Reply-To
