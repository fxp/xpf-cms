#!/usr/bin/env bash
# One-time (re-runnable) secret wiring for the cms Worker. Generated values never touch the terminal
# or any file except their destinations. Run from anywhere:  bash ~/Code/xpf-cms/ops/setup-secrets.sh
#
#   XPF_SIGNING_SECRET  (Worker)  ┐ same random value: Worker signs commits, CI gate verifies them
#   XPF_GATE_SECRET     (GitHub)  ┘
#   XPF_API_TOKEN       (Worker)  = ~/.config/xpf/token  (what the xpf CLI sends)
#   GITHUB_TOKEN        (Worker)  fine-grained PAT you paste: repo fxp/xiaopingfeng-site only,
#                                 Contents: read & write, Actions: read, Metadata: read
#   CLOUDFLARE_WORKERS_TOKEN (GitHub, optional) lets CI redeploy the cms.xiaopingfeng.com dashboard
#                                 (Workers Scripts: edit + Workers Routes/DNS: edit on xiaopingfeng.com)
set -euo pipefail
SITE_REPO="fxp/xiaopingfeng-site"
WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../packages/worker" && pwd)"
cd "$WORKER_DIR"

command -v openssl >/dev/null || { echo "openssl not found" >&2; exit 1; }
command -v gh >/dev/null || { echo "gh not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in" >&2; exit 1; }

put_worker() { printf %s "$2" | npx --yes wrangler secret put "$1" >/dev/null && echo "  ✓ Worker secret $1"; }
put_repo()   { printf %s "$2" | gh secret set "$1" -R "$SITE_REPO" && echo "  ✓ repo secret $1"; }

echo "Generating signing secret and API token…"
SIGN="$(openssl rand -hex 32)"
TOKEN="$(openssl rand -hex 32)"
put_worker XPF_SIGNING_SECRET "$SIGN"
put_repo   XPF_GATE_SECRET   "$SIGN"
put_worker XPF_API_TOKEN     "$TOKEN"
mkdir -p "$HOME/.config/xpf"
umask 077
printf %s "$TOKEN" > "$HOME/.config/xpf/token"
chmod 600 "$HOME/.config/xpf/token"
echo "  ✓ ~/.config/xpf/token (chmod 600)"
unset SIGN TOKEN

read -r -s -p "Paste the GitHub fine-grained PAT for $SITE_REPO (input hidden): " PAT; echo
[ -n "$PAT" ] || { echo "no PAT given; GITHUB_TOKEN not set" >&2; exit 1; }
put_worker GITHUB_TOKEN "$PAT"; unset PAT

read -r -s -p "Paste the Cloudflare Workers-deploy API token, or press Enter to skip (input hidden): " CF; echo
if [ -n "$CF" ]; then put_repo CLOUDFLARE_WORKERS_TOKEN "$CF"; else echo "  - skipped CLOUDFLARE_WORKERS_TOKEN (dashboard auto-refresh stays off)"; fi
unset CF

echo "Checking the Worker…"
curl -sS -m 20 https://cms-api.xiaopingfeng.com/healthz; echo
curl -sS -m 20 -o /dev/null -w "authenticated /api/items → HTTP %{http_code}\n" \
  https://cms-api.xiaopingfeng.com/api/items -H "authorization: Bearer $(cat "$HOME/.config/xpf/token")"
echo "Done."
