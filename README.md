# xpf-cms

Agent-first Artifact Management System for xiaopingfeng.com. Design: Obsidian vault `CMS/xpf-cms-架构设计.md`.

```bash
pnpm install
pnpm xpf validate --report reports/validate-$(date +%F).md      # read-only health check of ~/code/xiaopingfeng-site
pnpm xpf build llms --out /tmp/xpf-build                          # Markdown face: index.md · llms.txt · llms-full.txt
bash ops/backup.sh --full                                         # M0 backup (see ops/README.md)
```

Packages: `core` (schema v2, site loader, validator, HTML→Markdown, llms generators) · `cli` (`xpf`). Config: `config/verticals.json`.
