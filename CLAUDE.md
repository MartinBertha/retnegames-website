# retne.games website

Static site (`public/`) served by a Cloudflare Worker (`src/index.js`), configured in `wrangler.jsonc`. See `README.md` for Cloudflare setup.

## Workflow after every change

When a piece of work is finished, run these steps in order without waiting to be asked:

1. **Security review.** Before committing, check the changed files and the rest of the site for security problems:
   - No secrets in tracked files or in anything under `public/`, since everything there is publicly downloadable. That covers API keys, tokens, passwords, the Turnstile secret, the Resend API key and private keys.
   - Secrets belong only in Worker secrets (`npx wrangler secret put <NAME>`) or in the git-ignored local files `.dev.vars` and `.env`. The Turnstile *sitekey* is public and is allowed in `index.html`.
   - Nothing is newly added to git that `.gitignore` should cover (`.wrangler/`, `.dev.vars`, `.env*`, `node_modules/`, logs).
   - No weakening of the contact form protections: the Origin check, Turnstile validation, honeypot, input limits, rate limiting, security headers and CSP.
   - No new third-party scripts or unsafe handling of user input (e.g. rendering it as HTML).
   - If anything is found, stop and report it to the user before committing or deploying.
2. **Commit and push.** Commit the changes to `main` with a clear message and push to `origin` (GitHub).
3. **Upload to staging.** Run `npx wrangler versions upload --preview-alias staging`. This does not change the live site. Give the user the staging link, https://staging-retnegames-website.martin-bertha.workers.dev, and the version ID from the output, then **stop and wait for approval**. The link is behind Cloudflare Access (Cloudflare account members only), so the user has to log in to see it.
4. **Deploy to production, only after the user approves** the staging version. Run `npx wrangler versions deploy <version-id>@100% --yes` with the approved version ID, then check that https://retne.games serves the change.

If Wrangler asks for login (`npx wrangler login`), ask the user to do it; don't try to sign in yourself. If the push, upload or deploy fails, report the error. Don't retry with force options.

## Staging setup (don't undo)

- `wrangler.jsonc` must keep `"workers_dev": false` (the public `*.workers.dev` address stays off) and `"preview_urls": true` (staging links). Without these settings, deploys reset the dashboard toggles.
- Cloudflare Access on the Worker is scoped to **Previews only**, so retne.games stays public. Never switch it to "All traffic".
- The contact form only accepts the retne.games origins, so it can't be tested on staging. Form changes need a final check on production.
