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
3. **Deploy.** Deploy live with `npx wrangler deploy`, then confirm it succeeded. If Wrangler asks for login (`npx wrangler login`), ask the user to do it; don't try to sign in yourself.

If the push or the deploy fails, report the error. Don't retry with force options.
