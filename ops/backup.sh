#!/usr/bin/env bash
# xpf-cms · 全量备份脚本（迁移前 M0 门禁）
# 暂存于 Obsidian vault CMS/ops/；建好 ~/code/xpf-cms 后 mv 到 ops/backup.sh。
#
# 只读访问云端（GitHub / Cloudflare / Fly.io / Vercel），只写本机 ~/Backups/xpf/<date>/。
# 唯一的写操作是 --tag（给各仓库 main 打 pre-cms-<date> 标签并 push），需显式开启。
#
# 用法：
#   bash backup.sh --full            # 全量（不含 --tag / --kv-full / --r2）
#   bash backup.sh --inventory-only  # 只生成资产清单，不下载内容
#   bash backup.sh --full --tag      # 额外给仓库打基线标签
#   bash backup.sh --full --kv-full  # KV 空间 >5000 key 也全量导出
#   bash backup.sh --full --r2       # 用 rclone 同步 R2（需 R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY）
#   BACKUP_ROOT=/Volumes/ext/xpf bash backup.sh --full   # 指定落点
#
# 依赖：gh curl jq git tar；wrangler（或 npx）；可选 flyctl rclone age
# 凭证：~/.config/xpf-deploy/.env（CF_ACCOUNT_ID CF_EMAIL CF_GLOBAL_KEY | CF_API_TOKEN, FLY_API_TOKEN, VERCEL_TOKEN）
set -euo pipefail

DATE="$(date +%Y%m%d)"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/Backups/xpf}"
OUT="$BACKUP_ROOT/$DATE"
ENV_FILE="${ENV_FILE:-$HOME/.config/xpf-deploy/.env}"
GH_OWNER="${GH_OWNER:-fxp}"
CF_ZONE_ID="${CF_ZONE_ID:-94b5a60617d0ae84a3cc1eb4dbbfca58}"
KV_MAX_KEYS=5000

MODE=""; DO_TAG=0; KV_FULL=0; DO_R2=0
for a in "$@"; do
  case "$a" in
    --full) MODE=full ;;
    --inventory-only) MODE=inventory ;;
    --tag) DO_TAG=1 ;;
    --kv-full) KV_FULL=1 ;;
    --r2) DO_R2=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 2 ;;
  esac
done
[[ -z "$MODE" ]] && { echo "need --full or --inventory-only" >&2; exit 2; }

log()  { printf '\033[1;34m[backup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[backup] WARN\033[0m %s\n' "$*" >&2; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 3; }; }
for c in gh curl jq git tar; do need "$c"; done
HAVE_WRANGLER=0
if command -v wrangler >/dev/null 2>&1; then HAVE_WRANGLER=1; elif command -v npx >/dev/null 2>&1; then HAVE_WRANGLER=2; fi
HAVE_FLY=0;    command -v flyctl >/dev/null 2>&1 && HAVE_FLY=1
HAVE_RCLONE=0; command -v rclone >/dev/null 2>&1 && HAVE_RCLONE=1
HAVE_AGE=0;    command -v age    >/dev/null 2>&1 && HAVE_AGE=1
wr() { if [[ $HAVE_WRANGLER == 1 ]]; then wrangler "$@"; else npx --yes wrangler "$@"; fi; }

# ---- credentials -----------------------------------------------------------
load_env() { # safe KEY=VALUE parser: no eval/source, tolerates spaces, quotes, commas, '+' and '=' inside values
  local line key val
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^export[[:space:]]+ ]] && line="${line#export }"
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"; val="${line#*=}"; key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ "$val" =~ ^\"(.*)\"$ ]]; then val="${BASH_REMATCH[1]}"; elif [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    export "$key=$val"
  done < "$1"
}
if [[ -f "$ENV_FILE" ]]; then
  load_env "$ENV_FILE"
else
  warn "env file not found: $ENV_FILE (Cloudflare/Fly/Vercel steps will be skipped)"
fi
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
cf() { # cf <path-after-/client/v4> [curl args...]
  local path="$1"; shift
  if [[ -n "${CF_API_TOKEN:-}" ]]; then
    curl -sS "https://api.cloudflare.com/client/v4$path" -H "Authorization: Bearer $CF_API_TOKEN" "$@"
  elif [[ -n "${CF_GLOBAL_KEY:-}" && -n "${CF_EMAIL:-}" ]]; then
    curl -sS "https://api.cloudflare.com/client/v4$path" -H "X-Auth-Email: $CF_EMAIL" -H "X-Auth-Key: $CF_GLOBAL_KEY" "$@"
  else
    return 9
  fi
}
CF_OK=0
if [[ -n "$CF_ACCOUNT_ID" ]] && cf "/accounts/$CF_ACCOUNT_ID" 2>/dev/null | jq -e '.success' >/dev/null 2>&1; then CF_OK=1; else warn "Cloudflare API not usable; skipping Cloudflare steps"; fi
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"
if [[ -n "${CF_API_TOKEN:-}" ]]; then export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
elif [[ -n "${CF_GLOBAL_KEY:-}" && -n "${CF_EMAIL:-}" ]]; then export CLOUDFLARE_API_KEY="$CF_GLOBAL_KEY" CLOUDFLARE_EMAIL="$CF_EMAIL"; fi

mkdir -p "$OUT"/{git,github,cloudflare/{workers,pages,kv,d1,r2},fly,vercel,claude,secrets,vault,inventory}
log "output: $OUT  (mode=$MODE tag=$DO_TAG kv-full=$KV_FULL r2=$DO_R2)"
echo "started $(date -Iseconds)" > "$OUT/SUMMARY.md"

# ---- 1/2. GitHub ------------------------------------------------------------
log "GitHub: repo inventory"
gh repo list "$GH_OWNER" --limit 300 --json name,isPrivate,updatedAt,pushedAt,sshUrl,url,diskUsage,isArchived \
  > "$OUT/inventory/github-repos.json"
REPO_COUNT=$(jq length "$OUT/inventory/github-repos.json")
log "GitHub: $REPO_COUNT repos"
if [[ $MODE == full ]]; then
  jq -r '.[] | select(.isArchived==false) | .name' "$OUT/inventory/github-repos.json" | while read -r name; do
    if [[ -d "$OUT/git/$name.git" ]]; then
      git -C "$OUT/git/$name.git" remote update --prune >/dev/null 2>&1 || warn "update failed: $name"
    else
      ok=0
      for attempt in 1 2 3; do
        if git clone --quiet --mirror "https://github.com/$GH_OWNER/$name.git" "$OUT/git/$name.git" 2>>"$OUT/inventory/git-mirror-errors.log"; then ok=1; break; fi
        rm -rf "$OUT/git/$name.git"; sleep $((attempt*5))
      done
      [[ $ok == 1 ]] || warn "mirror failed after 3 attempts: $name"
      sleep 1
    fi
  done
  for name in xiaopingfeng-site roam todo-service mac-api; do
    mkdir -p "$OUT/github/$name"
    gh api "repos/$GH_OWNER/$name/actions/secrets" --jq '.secrets[].name' > "$OUT/github/$name/secret-names.txt" 2>/dev/null || true
    gh api "repos/$GH_OWNER/$name/actions/workflows" > "$OUT/github/$name/workflows.json" 2>/dev/null || true
    gh issue list -R "$GH_OWNER/$name" --state all --limit 500 --json number,title,state,createdAt,labels > "$OUT/github/$name/issues.json" 2>/dev/null || true
  done
fi
if [[ $DO_TAG == 1 ]]; then
  for name in xiaopingfeng-site roam todo-service mac-api; do
    if [[ -d "$HOME/code/$name/.git" ]]; then
      ( cd "$HOME/code/$name" && git fetch -q origin && git tag -f "pre-cms-$DATE" origin/main && git push -q origin "pre-cms-$DATE" ) \
        && log "tagged $name pre-cms-$DATE" || warn "tag failed: $name"
    else
      warn "no local checkout for $name; tag skipped"
    fi
  done
fi

# ---- 3–9. Cloudflare --------------------------------------------------------
if [[ $CF_OK == 1 ]]; then
  log "Cloudflare: zones + DNS export (all zones in account)"
  cf "/zones?per_page=50" | jq . > "$OUT/inventory/cf-zones.json"
  jq -r '.result[] | "\(.id)\t\(.name)"' "$OUT/inventory/cf-zones.json" | while IFS=$'\t' read -r zid zname; do
    cf "/zones/$zid/dns_records/export" > "$OUT/cloudflare/dns-$zname.bind" || warn "dns export failed: $zname"
    cf "/zones/$zid/dns_records?per_page=500" | jq . > "$OUT/cloudflare/dns-$zname.json" || true
    cf "/zones/$zid/workers/routes" | jq . > "$OUT/cloudflare/routes-$zname.json" || true
    cf "/zones/$zid/settings" | jq . > "$OUT/cloudflare/settings-$zname.json" || true
  done

  log "Cloudflare: Workers"
  cf "/accounts/$CF_ACCOUNT_ID/workers/scripts" | jq . > "$OUT/inventory/cf-workers.json"
  cf "/zones/$CF_ZONE_ID/workers/routes" | jq . > "$OUT/cloudflare/workers-routes.json"
  cf "/accounts/$CF_ACCOUNT_ID/workers/domains" | jq . > "$OUT/cloudflare/workers-domains.json" || true
  if [[ $MODE == full ]]; then
    jq -r '.result[].id' "$OUT/inventory/cf-workers.json" | while read -r w; do
      d="$OUT/cloudflare/workers/$w"; mkdir -p "$d"
      cf "/accounts/$CF_ACCOUNT_ID/workers/scripts/$w" > "$d/script.raw" || warn "script download failed: $w"
      cf "/accounts/$CF_ACCOUNT_ID/workers/scripts/$w/settings" | jq . > "$d/settings.json" || true
      cf "/accounts/$CF_ACCOUNT_ID/workers/scripts/$w/schedules" | jq . > "$d/schedules.json" || true
      cf "/accounts/$CF_ACCOUNT_ID/workers/scripts/$w/secrets" | jq '[.result[]?.name]' > "$d/secret-names.json" 2>/dev/null || true
    done
  fi

  log "Cloudflare: Pages"
  cf "/accounts/$CF_ACCOUNT_ID/pages/projects" | jq . > "$OUT/inventory/cf-pages.json"
  if [[ $MODE == full ]]; then
    jq -r '.result[].name' "$OUT/inventory/cf-pages.json" | while read -r p; do
      d="$OUT/cloudflare/pages/$p"; mkdir -p "$d"
      cf "/accounts/$CF_ACCOUNT_ID/pages/projects/$p" | jq . > "$d/project.json"
      cf "/accounts/$CF_ACCOUNT_ID/pages/projects/$p/domains" | jq . > "$d/domains.json" || true
      cf "/accounts/$CF_ACCOUNT_ID/pages/projects/$p/deployments?per_page=25" | jq . > "$d/deployments.json" || true
    done
  fi

  log "Cloudflare: KV"
  cf "/accounts/$CF_ACCOUNT_ID/storage/kv/namespaces?per_page=100" | jq . > "$OUT/inventory/cf-kv.json"
  if [[ $MODE == full ]]; then
    jq -r '.result[] | "\(.id)\t\(.title)"' "$OUT/inventory/cf-kv.json" | while IFS=$'\t' read -r id title; do
      d="$OUT/cloudflare/kv/$title"; mkdir -p "$d"
      cf "/accounts/$CF_ACCOUNT_ID/storage/kv/namespaces/$id/keys?limit=1000" | jq . > "$d/keys.json"
      n=$(jq '.result | length' "$d/keys.json")
      if [[ $n -gt $KV_MAX_KEYS && $KV_FULL == 0 ]]; then warn "KV $title has >$KV_MAX_KEYS keys; values skipped (use --kv-full)"; continue; fi
      mkdir -p "$d/values"
      jq -r '.result[].name' "$d/keys.json" | while read -r k; do
        ek=$(jq -rn --arg k "$k" '$k|@uri')
        cf "/accounts/$CF_ACCOUNT_ID/storage/kv/namespaces/$id/values/$ek" > "$d/values/$(echo -n "$k" | tr '/' '_')" || true
      done
    done
  fi

  log "Cloudflare: D1"
  cf "/accounts/$CF_ACCOUNT_ID/d1/database" | jq . > "$OUT/inventory/cf-d1.json"
  if [[ $MODE == full && $HAVE_WRANGLER != 0 ]]; then
    jq -r '.result[].name' "$OUT/inventory/cf-d1.json" | while read -r db; do
      wr d1 export "$db" --remote --output "$OUT/cloudflare/d1/$db.sql" >/dev/null 2>&1 && log "D1 exported: $db" || warn "D1 export failed: $db"
    done
  fi

  log "Cloudflare: R2 / Access / Email routing"
  cf "/accounts/$CF_ACCOUNT_ID/r2/buckets" | jq . > "$OUT/inventory/cf-r2.json"
  cf "/accounts/$CF_ACCOUNT_ID/access/apps" | jq . > "$OUT/cloudflare/access-apps.json" || true
  cf "/zones/$CF_ZONE_ID/email/routing/rules" | jq . > "$OUT/cloudflare/email-routing.json" || true
  if [[ $DO_R2 == 1 ]]; then
    if [[ $HAVE_RCLONE == 1 && -n "${R2_ACCESS_KEY_ID:-}" && -n "${R2_SECRET_ACCESS_KEY:-}" ]]; then
      jq -r '.result.buckets[].name' "$OUT/inventory/cf-r2.json" | while read -r b; do
        rclone sync ":s3,provider=Cloudflare,access_key_id=$R2_ACCESS_KEY_ID,secret_access_key=$R2_SECRET_ACCESS_KEY,endpoint=https://$CF_ACCOUNT_ID.r2.cloudflarestorage.com:$b" \
          "$OUT/cloudflare/r2/$b" --fast-list -q && log "R2 synced: $b" || warn "R2 sync failed: $b"
      done
    else
      warn "--r2 requested but rclone or R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY missing"
    fi
  fi
fi

# ---- 10. Fly.io -------------------------------------------------------------
if [[ $HAVE_FLY == 1 && -n "${FLY_API_TOKEN:-}" ]]; then
  log "Fly.io"
  export FLY_ACCESS_TOKEN="$FLY_API_TOKEN"
  flyctl apps list --json > "$OUT/inventory/fly-apps.json" 2>/dev/null || warn "fly apps list failed"
  if [[ $MODE == full && -s "$OUT/inventory/fly-apps.json" ]]; then
    jq -r '.[] | (.Name // .name)' "$OUT/inventory/fly-apps.json" 2>/dev/null | while read -r app; do
      d="$OUT/fly/$app"; mkdir -p "$d"
      ( cd "$d" && flyctl config save -a "$app" -y >/dev/null 2>&1 ) || true
      flyctl secrets list -a "$app" --json > "$d/secret-names.json" 2>/dev/null || true
      flyctl machines list -a "$app" --json > "$d/machines.json" 2>/dev/null || true
      flyctl volumes list -a "$app" --json > "$d/volumes.json" 2>/dev/null || true
    done
  fi
else
  warn "flyctl or FLY_API_TOKEN missing; Fly.io skipped"
fi

# ---- 11. Vercel -------------------------------------------------------------
if [[ -n "${VERCEL_TOKEN:-}" ]]; then
  log "Vercel"
  vc() { curl -sS "https://api.vercel.com$1" -H "Authorization: Bearer $VERCEL_TOKEN"; }
  vc "/v9/projects?limit=100" | jq . > "$OUT/inventory/vercel-projects.json"
  if [[ $MODE == full ]]; then
    jq -r '.projects[] | "\(.id)\t\(.name)"' "$OUT/inventory/vercel-projects.json" | while IFS=$'\t' read -r id name; do
      d="$OUT/vercel/$name"; mkdir -p "$d"
      vc "/v9/projects/$id" | jq . > "$d/project.json"
      vc "/v9/projects/$id/domains" | jq . > "$d/domains.json" || true
      if vc "/v9/projects/$id/env?decrypt=true" | jq . > "$OUT/secrets/vercel-env-$name.json" 2>/dev/null; then chmod 600 "$OUT/secrets/vercel-env-$name.json"; fi
    done
  fi
else
  warn "VERCEL_TOKEN missing; Vercel skipped"
fi

# ---- 12. Aliyun FC (TODO) ---------------------------------------------------
echo "TODO: export zschool.xiaopingfeng.com Aliyun Function Compute config manually (aliyun CLI not wired)" > "$OUT/inventory/aliyun-TODO.txt"

# ---- 13. local secrets (encrypted) -----------------------------------------
if [[ $MODE == full ]]; then
  log "local secrets → tarball"
  SECRET_PATHS=()
  for p in "$HOME/.config/xpf-deploy" "$HOME/.config/mac-api" "$HOME/.config/xpf-todo" "$HOME/Workspace/VendlingConfig/secrets" "$HOME/.claude.json" "$HOME/.claude/.credentials.json"; do
    [[ -e "$p" ]] && SECRET_PATHS+=("$p")
  done
  if [[ ${#SECRET_PATHS[@]} -gt 0 ]]; then
    if [[ $HAVE_AGE == 1 && -n "${AGE_RECIPIENT:-}" ]]; then
      tar -czf - "${SECRET_PATHS[@]}" 2>/dev/null | age -r "$AGE_RECIPIENT" -o "$OUT/secrets/secrets-$DATE.tar.gz.age"
      log "secrets encrypted with age → secrets-$DATE.tar.gz.age"
    else
      tar -czf "$OUT/secrets/secrets-$DATE.tar.gz" "${SECRET_PATHS[@]}" 2>/dev/null; chmod 600 "$OUT/secrets/secrets-$DATE.tar.gz"
      warn "age/AGE_RECIPIENT not set: secrets tarball is PLAINTEXT (chmod 600). Do NOT copy it off this machine unencrypted."
    fi
  fi
fi

# ---- 14. Claude Code assets -------------------------------------------------
if [[ $MODE == full ]]; then
  log "Claude Code assets"
  tar -czf "$OUT/claude/skills-$DATE.tar.gz" -C "$HOME/.claude" skills 2>/dev/null || true
  tar -czf "$OUT/claude/plans-$DATE.tar.gz"  -C "$HOME/.claude" plans  2>/dev/null || true
  MEM_DIR="$HOME/.claude/projects/-Users-xiaopingfeng-Library-Mobile-Documents-iCloud-md-obsidian-Documents/memory"
  [[ -d "$MEM_DIR" ]] && tar -czf "$OUT/claude/memory-$DATE.tar.gz" -C "$(dirname "$MEM_DIR")" memory || true
fi

# ---- 15. Obsidian vault (content only: prune node_modules/.git/dist/build; skip pptx/mp4/mov/zip/dmg; <10MB) ----
if [[ $MODE == full ]]; then
  VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents"
  if [[ -d "$VAULT" ]]; then
    log "Obsidian vault (content-only filter; the vault is ~170 GB with media, a naive tar is wrong)"
    LIST="$OUT/vault/filelist.txt"
    ( cd "$(dirname "$VAULT")" && find "$(basename "$VAULT")" \
        \( -name node_modules -o -name .git -o -name dist -o -name build -o -name .next -o -name .venv -o -name __pycache__ -o -name .DS_Store \) -prune -o \
        -type f ! -name '*.pptx' ! -name '*.mp4' ! -name '*.mov' ! -name '*.zip' ! -name '*.dmg' ! -name '*.icloud' -size -10M -print ) > "$LIST" 2>"$OUT/vault/find-errors.log" || true
    tar -czf "$OUT/vault/vault-content-$DATE.tar.gz" -C "$(dirname "$VAULT")" -T "$LIST" 2>"$OUT/vault/tar-errors.log" || warn "vault tar had warnings (see vault/tar-errors.log)"
    log "vault: $(wc -l < "$LIST" | tr -d ' ') files, archive $(du -h "$OUT/vault/vault-content-$DATE.tar.gz" | cut -f1)"
    echo "media (*.pptx/*.mp4/*.mov/*.zip) and >10MB files are NOT archived here; they live in iCloud — rsync 'AI Buzzwords' / 'Projects' large assets to an external drive separately" > "$OUT/vault/README.txt"
  fi
fi

# ---- manifest ---------------------------------------------------------------
log "manifest"
( cd "$OUT" && find . -type f ! -name MANIFEST.sha256 -print0 | xargs -0 shasum -a 256 > MANIFEST.sha256 )
{
  echo "finished $(date -Iseconds)"
  echo "mode=$MODE tag=$DO_TAG kv-full=$KV_FULL r2=$DO_R2"
  echo "github repos: $REPO_COUNT"
  [[ -f "$OUT/inventory/cf-workers.json" ]] && echo "cf workers: $(jq '.result|length' "$OUT/inventory/cf-workers.json")"
  [[ -f "$OUT/inventory/cf-pages.json" ]]   && echo "cf pages:   $(jq '.result|length' "$OUT/inventory/cf-pages.json")"
  [[ -f "$OUT/inventory/cf-kv.json" ]]      && echo "cf kv ns:   $(jq '.result|length' "$OUT/inventory/cf-kv.json")"
  [[ -f "$OUT/inventory/cf-d1.json" ]]      && echo "cf d1:      $(jq '.result|length' "$OUT/inventory/cf-d1.json")"
  [[ -f "$OUT/inventory/cf-r2.json" ]]      && echo "cf r2:      $(jq '.result.buckets|length' "$OUT/inventory/cf-r2.json")"
  [[ -f "$OUT/inventory/fly-apps.json" ]]   && echo "fly apps:   $(jq 'length' "$OUT/inventory/fly-apps.json")"
  [[ -f "$OUT/inventory/vercel-projects.json" ]] && echo "vercel:     $(jq '.projects|length' "$OUT/inventory/vercel-projects.json")"
  echo "size: $(du -sh "$OUT" | cut -f1)"
} >> "$OUT/SUMMARY.md"
cat "$OUT/SUMMARY.md"
log "done → $OUT"
log "next: copy off-site, e.g.  rclone sync \"$OUT\" r2:xpf-backup/$DATE   and/or   rclone sync \"$OUT\" b2:xpf-backup/$DATE"
