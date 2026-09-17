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

Live at **https://xpf-cms-dashboard.fxp007.workers.dev** (no auth yet — see `packages/admin/README.md`). Redeploy after rebuilding:

```bash
pnpm xpf build dashboard --out /tmp/xpf-dashboard
cd /tmp/xpf-dashboard
CLOUDFLARE_API_KEY=<global key> CLOUDFLARE_EMAIL=<email> CLOUDFLARE_ACCOUNT_ID=<account id> \
  npx wrangler pages deploy . --project-name=xpf-cms-dashboard
```

Not yet on a CI schedule — see the design doc's P2/P3 for when this moves to the real `cms Worker` with live D1 data and Access auth instead of a manually-redeployed static snapshot.
