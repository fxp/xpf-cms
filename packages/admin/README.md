# @xpf/admin

Static ops dashboard for xpf-cms. Reads the same data `xpf validate` computes
(site items, validation findings, operational queues) plus the latest
`~/Backups/xpf/<date>/inventory/*.json` snapshot, and renders one
self-contained `index.html` — no server, no database, no auth yet.

```bash
pnpm xpf build dashboard --out /tmp/xpf-dashboard
```

Shows: item/error/warning counts · queues (drafts stuck on main, freshness
due, expiring rotation assets, missing summary/category, DeepDive articles
with no English version, unregistered-but-published items, failed meta
validation) · per-vertical counts · infra snapshot with week-over-week delta
· 24 most recent published items.

Deployed to `https://xpf-cms-dashboard.fxp007.workers.dev` (Cloudflare
Pages/Workers, redeployed manually for now — see root README). `_headers`
sets `X-Robots-Tag: noindex` and `Cache-Control: no-store`; there is
**no authentication yet** — nothing on the page is a credential, but treat
the URL as unlisted, not public, until Access is wired up (P2/P3 in the
architecture doc).
