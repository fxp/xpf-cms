# xpf-cms

Agent-first Artifact Management System for xiaopingfeng.com. Design: Obsidian vault `CMS/xpf-cms-架构设计.md`.

```bash
pnpm install
pnpm xpf validate --report reports/validate-$(date +%F).md      # read-only health check of ~/code/xiaopingfeng-site
pnpm xpf build llms --out /tmp/xpf-build                          # Markdown face: index.md · llms.txt · llms-full.txt
pnpm xpf build dashboard --out /tmp/xpf-dashboard                 # static ops dashboard (queues, verticals, infra snapshot)
bash ops/backup.sh --full                                         # M0 backup (see ops/README.md)
pnpm xpf register howto/<slug> --site <ws> --title "…"           # next id into the working tree's config/content-index.json (--remove: tombstone)
pnpm xpf publish|update|remove <type>/<slug> --site <ws> [--dry-run --remote]   # send the item's owned files to the cms Worker
```

Skills use these through `~/.claude/skills/cms-publish` (clean sparse workspace via `xpf-ws`, then `xpf register/publish`).

Packages: `core` (schema v2, site loader, validator, HTML→Markdown, llms generators) · `admin` (dashboard) · `cli` (`xpf`). Config: `config/verticals.json`.

## Buzzwords publishing and Graph

On the production branch, a new episode or an update that sends its `index.html` moves to `awaiting_graph` after the episode deploys and passes the site check. `xpf status <episode-instance>` reports the episode and the next action.

For a presentation-only episode update with no changes to Graph inputs, pass `--no-graph-sync` to `xpf update`. This option applies only to Buzzwords updates.

Use the `buzzwords-episode` skill on the Obsidian host to import the models and deployed episode into Graph, then publish `graph/site` through CMS. Once the Graph instance is `done`, close the episode's follow-up with:

```bash
pnpm xpf graph-complete <episode-instance> <graph-instance>
```

CMS checks that the Graph commit follows the episode commit and that the public episode entity, model query and mention index are available. A failed check leaves the episode at `awaiting_graph` so completion can be retried independently of publishing the episode.

## Dashboard

Live at **https://cms.xiaopingfeng.com**, gated by Auth0 login (`packages/dashboard-worker`) — see that package's README for the OAuth flow and the one manual step still needed in the Auth0 dashboard (Allowed Callback URLs) before login actually completes. Rebuild + redeploy:

```bash
pnpm xpf build dashboard --out packages/dashboard-worker/public   # regenerate dashboard content
cd packages/dashboard-worker
npx wrangler deploy                                                # picks up wrangler.jsonc + already-set secrets
```

Not yet on a CI schedule — see the design doc's P2/P3 for when this moves to the real `cms Worker` with live D1 data instead of a manually-redeployed static snapshot.
