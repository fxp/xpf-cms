# xpf-cms

Agent-first Artifact Management System for xiaopingfeng.com. Design: Obsidian vault `CMS/xpf-cms-架构设计.md`.

```bash
pnpm install
pnpm xpf validate --report reports/validate-$(date +%F).md      # read-only health check of ~/code/xiaopingfeng-site
pnpm xpf build llms --out /tmp/xpf-build                          # Markdown face: index.md · llms.txt · llms-full.txt
pnpm xpf build dashboard --out /tmp/xpf-dashboard                 # static ops dashboard (queues, verticals, infra snapshot)
bash ops/backup.sh --full                                         # M0 backup (see ops/README.md)
```

Packages: `core` (schema v2, site loader, validator, HTML→Markdown, llms generators) · `admin` (dashboard) · `cli` (`xpf`). Config: `config/verticals.json`.

## Dashboard

Live at **https://xpf-cms-dashboard.fxp007.workers.dev**, gated by Auth0 login (`packages/dashboard-worker`) — see that package's README for the OAuth flow and the one manual step still needed in the Auth0 dashboard (Allowed Callback URLs) before login actually completes. Rebuild + redeploy:

```bash
pnpm xpf build dashboard --out packages/dashboard-worker/public   # regenerate dashboard content
cd packages/dashboard-worker
npx wrangler deploy                                                # picks up wrangler.jsonc + already-set secrets
```

Not yet on a CI schedule — see the design doc's P2/P3 for when this moves to the real `cms Worker` with live D1 data instead of a manually-redeployed static snapshot.
