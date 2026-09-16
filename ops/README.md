# xpf-cms · ops（暂存于 vault，建仓后 mv 到 `~/code/xpf-cms/ops/`）

迁移前后运维脚本。主方案见同级 `../xiaopingfeng-cms-调研与架构设计.md`（§7 迁移计划、§8 备份计划）。

## backup.sh

```bash
# 依赖
brew install gh jq rclone age            # wrangler 用 npx 也可；flyctl 可选
gh auth status                            # 需要能访问 fxp 名下私有仓库

# 路径（vault 内）
S="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/CMS/ops/backup.sh"

# 全量备份（只读云端，只写 ~/Backups/xpf/<date>/）
bash "$S" --full

# 只出清单（不下载）
bash "$S" --inventory-only

# 打基线标签（唯一的写操作，显式开启）
bash "$S" --full --tag

# 可选：R2 对象同步（需要 R2 S3 令牌）
R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... bash "$S" --full --r2

# 可选：用 age 加密本机密钥归档（强烈建议）
age-keygen -o ~/.config/xpf-backup-age.key                      # 一次
AGE_RECIPIENT=$(grep -o 'age1[0-9a-z]*' ~/.config/xpf-backup-age.key) bash "$S" --full
```

凭证读取自 `~/.config/xpf-deploy/.env`：`CF_ACCOUNT_ID`、`CF_EMAIL` + `CF_GLOBAL_KEY`（或更推荐的 `CF_API_TOKEN`）、`FLY_API_TOKEN`、`VERCEL_TOKEN`。

输出结构：

```
~/Backups/xpf/<date>/
├─ git/<repo>.git            镜像克隆
├─ github/<repo>/            workflows / secret 名称 / issues
├─ cloudflare/               dns-*.bind · dns-records.json · workers/<name>/{script.raw,settings.json,...} · pages/ · kv/<ns>/ · d1/<db>.sql · access-apps.json · email-routing.json
├─ fly/<app>/                fly.toml · secret-names · machines · volumes
├─ vercel/<project>/         project.json · domains.json
├─ secrets/                  secrets-<date>.tar.gz(.age) · vercel-env-*.json   ← chmod 600；未加密不得离开本机
├─ claude/                   skills / plans / memory
├─ vault/                    Obsidian vault（排除 pptx/视频）
├─ inventory/                各云资产清单 JSON（也是服务注册表漂移检测的基线）
├─ MANIFEST.sha256
└─ SUMMARY.md
```

## 异地副本（3-2-1）

```bash
rclone sync ~/Backups/xpf/<date> r2:xpf-backup/<date>      # 同账号，快
rclone sync ~/Backups/xpf/<date> b2:xpf-backup/<date>      # 异地（Backblaze B2 或外置盘），至少 git + cloudflare + secrets(.age)
```

## 恢复演练（M0 门禁）

1. `git clone ~/Backups/xpf/<date>/git/xiaopingfeng-site.git /tmp/site && npx serve -l 8787 /tmp/site` → 随机打开 10 个 URL。
2. `wrangler d1 create scratch && wrangler d1 execute scratch --remote --file ~/Backups/xpf/<date>/cloudflare/d1/xpf-todo.sql`。
3. 取 `cloudflare/workers/<name>/script.raw` 在 staging 名字下 `wrangler deploy` 成功。
4. `age -d -i ~/.config/xpf-backup-age.key secrets-<date>.tar.gz.age | tar -tzf - | wc -l` 与源文件数一致。

## 状态

- 2026-09-09 14:22 `--inventory-only` 跑通（18 秒）：GitHub 150 仓库 · Workers 100 · Pages 7 · KV 16 · D1 18 · R2 9 · Vercel 11。
- 2026-09-09 14:24–15:03 `--full` 完成，2.5 GB，落点 `~/Backups/xpf/20260909/`；恢复演练 ①②③④ 通过（见主方案 §8.5）。
- vault 步骤返工为"内容过滤"归档：241,282 个文件，4.0 GB，0 错误（vault 实际 73 万文件 / 170 GB，媒体靠 iCloud + 外置盘）；备份总量 6.5 GB。
- 已知修复：`.env` 值含空格/逗号时 `source` 失败 → 改逐行解析；`wrangler` 用 Global Key 时需 `CLOUDFLARE_API_KEY/EMAIL`；管道里的 `sed` 请用 `sed -u` 否则日志到结束才落盘。
- 待办：异地副本；Aliyun FC；Notion 导出；Fly 令牌加引号并轮换。
- 2026-09-09：DNS/路由/设置导出改为遍历账号下全部 zone（`inventory/cf-zones.json`，当前 6 个：carbonleft.com · fengxiaoping.com · ln-s.run · vendling.dev · wangyihan.app · xiaopingfeng.com）；此前只导出主站一个 zone。
- 2026-09-16 13:21–14:58 第二次 `--full` 完成，11 GB，落点 `~/Backups/xpf/20260916/`：GitHub 160 仓库（非归档 158 全部镜像）· zone 8（新增 vendling.ai / vendling.sh）· Workers 112 · D1 20 · R2 11 · Fly 18 · Vercel 11 · vault 279,482 文件 4.8 GB（0 错误）· 密钥 age 加密。
- 该次两个教训：① 160 个仓库连续克隆有 124 个被 GitHub 限流/网络抖动打断（公开私有都有），已给脚本加 3 次重试 + 退避 + 每仓 1 秒间隔，并用 `gh repo clone -- --mirror` 单独补齐；② **脚本运行中不要编辑脚本文件**——bash 边读边执行，改动会让运行中的实例报假"syntax error"并中断（本次 manifest/summary 因此手工重建）。
- 已知小项：Worker `gh-olney1-chatgpt-openai-smart-speaker` 脚本下载失败（实验性遗留，可忽略或删除）。
