# @xpf/dashboard-worker

Cloudflare Worker that puts an Auth0 login gate in front of the static
dashboard built by `@xpf/admin`. Every request — including `/data.json` —
goes through `fetch()` first (`run_worker_first: true` in `wrangler.jsonc`;
without it, requests matching a static file bypass the Worker entirely and
the gate becomes a no-op for exactly the files it's supposed to protect).

## Flow

1. No/invalid/expired session cookie → 302 to `/login`.
2. `/login` generates a PKCE verifier/challenge + `state` + `nonce`, stores
   them in a 10-minute `xpf_pkce` cookie, redirects to Auth0 `/authorize`.
3. `/callback` checks `state`, exchanges `code` + `code_verifier` for tokens
   (no client secret sent unless `AUTH0_CLIENT_SECRET` is set — works as-is
   against a Single Page Application / public client), verifies the ID token
   against Auth0's JWKS (issuer + audience + nonce), checks the token's
   `email` claim against `ALLOWED_EMAILS`, then mints the app's own 7-day
   HMAC-signed session cookie (`xpf_session`) — everyday requests just verify
   that signature locally, no JWKS fetch or Auth0 round-trip per request.
4. `/logout` clears the session cookie and redirects to Auth0's logout URL.

## One-time setup required in the Auth0 dashboard (I cannot do this myself —
no Management API token was provided, only a Client ID)

**Domain history**: this was `xpf-cms-dashboard.fxp007.workers.dev` until 2026-09-17, when a custom domain route was added — that also disabled the old `*.workers.dev` URL (Wrangler's default once explicit `routes` exist), so the Auth0 application needs the *new* URLs added below in addition to (or instead of) the old ones; the old workers.dev callback entry can stay registered harmlessly or be removed.

In the Auth0 application's **Settings** page, add to:
- **Allowed Callback URLs**: `https://cms.xiaopingfeng.com/callback`
- **Allowed Logout URLs**: `https://xpf-cms-dashboard.fxp007.workers.dev`
- **Allowed Web Origins**: `https://xpf-cms-dashboard.fxp007.workers.dev`

The application is a **Regular Web Application** (confirmed), so
`AUTH0_CLIENT_SECRET` is required and already set as a Worker secret — the
token exchange sends it alongside the PKCE verifier.

## Deploy

```bash
pnpm xpf build dashboard --out packages/dashboard-worker/public   # rebuild dashboard content
cd packages/dashboard-worker
npx wrangler secret put SESSION_SECRET   # once, or to rotate — openssl rand -hex 32
npx wrangler deploy
```

`ALLOWED_EMAILS` (who's allowed in after Auth0 login succeeds) and
`AUTH0_DOMAIN`/`AUTH0_CLIENT_ID` live as plain `vars` in `wrangler.jsonc`,
not secrets — edit and redeploy to change them.
