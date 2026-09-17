import type { Finding, Site } from "@xpf/core";
import { absUrl, itemDate, itemTitle, itemState, isPublic } from "@xpf/core";
import type { Queues, QueueEntry } from "./queues.ts";
import type { InfraSnapshot } from "./infra.ts";

const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function fmtDelta(n: number): string {
  if (n > 0) return `<span class="up">▲${n}</span>`;
  if (n < 0) return `<span class="down">▼${Math.abs(n)}</span>`;
  return `<span class="flat">–</span>`;
}

function queueSection(id: string, label: string, hint: string, entries: QueueEntry[], limit = 30): string {
  const rows = entries.slice(0, limit).map(e => `
    <tr>
      <td>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</td>
      <td class="ref">${esc(e.ref)}</td>
      <td class="detail">${esc(e.detail)}</td>
    </tr>`).join("");
  const more = entries.length > limit ? `<p class="more">… 另 ${entries.length - limit} 条</p>` : "";
  return `
  <section class="queue" id="q-${id}">
    <button class="queue-head" data-toggle="q-${id}-body" aria-expanded="${entries.length > 0}">
      <span class="qcount ${entries.length === 0 ? "zero" : ""}">${entries.length}</span>
      <span class="qlabel">${esc(label)}</span>
      <span class="qhint">${esc(hint)}</span>
      <span class="chev">▾</span>
    </button>
    <div class="queue-body" id="q-${id}-body" ${entries.length === 0 ? "hidden" : ""}>
      ${entries.length === 0 ? '<p class="empty">空 · 没有待处理项</p>' : `<table><thead><tr><th>标题</th><th>ref</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table>${more}`}
    </div>
  </section>`;
}

export function renderDashboard(opts: {
  site: Site; findings: Finding[]; stats: Record<string, number>; queues: Queues; infra: InfraSnapshot;
  generatedAt: string; siteRepoCommit?: string;
}): string {
  const { site, findings, stats, queues, infra, generatedAt } = opts;
  const errors = findings.filter(f => f.severity === "error").length;
  const warnings = findings.filter(f => f.severity === "warning").length;
  const infos = findings.length - errors - warnings;

  const byType = new Map<string, { n: number; pub: number }>();
  for (const it of site.items) {
    const t = byType.get(it.type) ?? { n: 0, pub: 0 };
    t.n++; if (isPublic(it)) t.pub++;
    byType.set(it.type, t);
  }
  const verticalRows = [...byType.entries()].sort((a, b) => b[1].n - a[1].n).map(([type, { n, pub }]) => {
    const v = site.config.verticals[type];
    return `<tr><td>${esc(v?.label ?? type)}</td><td>${n}</td><td>${pub}</td><td><a href="${esc(site.config.site.base_url)}${esc(v?.url_prefix ?? "/" + type + "/")}llms.txt" target="_blank" rel="noopener">llms.txt →</a></td></tr>`;
  }).join("");

  const recent = [...site.items].filter(isPublic).sort((a, b) => (itemDate(b) ?? "").localeCompare(itemDate(a) ?? "")).slice(0, 24);
  const recentRows = recent.map(it => `
    <tr>
      <td class="mono">${esc(itemDate(it) ?? "")}</td>
      <td><a href="${esc(absUrl(site, it))}" target="_blank" rel="noopener">${esc(itemTitle(it))}</a></td>
      <td>${esc(site.config.verticals[it.type]?.label ?? it.type)}</td>
    </tr>`).join("");

  const infraRows = Object.entries(infra.counts).map(([k, v]) => `
    <tr><td>${esc(k)}</td><td class="mono">${v}</td><td>${infra.delta ? fmtDelta(infra.delta[k] ?? 0) : ""}</td></tr>`).join("");

  const codeRows = (() => {
    const byCode = new Map<string, { n: number; sev: string }>();
    for (const f of findings) byCode.set(f.code, { n: (byCode.get(f.code)?.n ?? 0) + 1, sev: f.severity });
    return [...byCode.entries()].sort((a, b) => b[1].n - a[1].n)
      .map(([code, { n, sev }]) => `<tr class="sev-${sev}"><td>${esc(code)}</td><td>${esc(sev)}</td><td class="mono">${n}</td></tr>`).join("");
  })();

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>xpf-cms Dashboard</title>
<style>
  :root {
    --bg: #0f1115; --panel: #161922; --panel2: #1c2029; --border: #2a2f3a;
    --text: #e6e8ee; --dim: #8b93a7; --mute: #5c6479;
    --accent: #6ea8fe; --ok: #4ade80; --warn: #fbbf24; --err: #f87171;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, "PingFang SC", "Noto Sans SC", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); }
  body { padding: 0 0 64px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header { padding: 28px 5vw 20px; border-bottom: 1px solid var(--border); display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  header h1 { font-size: 20px; font-weight: 600; margin: 0; }
  header .meta { font-family: var(--mono); font-size: 12px; color: var(--mute); }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 5vw 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .card .n { font-family: var(--mono); font-size: 28px; font-weight: 600; line-height: 1; }
  .card .l { font-size: 12px; color: var(--dim); margin-top: 6px; }
  .card.err .n { color: var(--err); } .card.warn .n { color: var(--warn); } .card.ok .n { color: var(--ok); }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 32px 0 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--mute); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 6px 10px; border-bottom: 1px solid var(--border); }
  td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: var(--mono); }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .panel table { }
  .panel td, .panel th { padding-left: 16px; padding-right: 16px; }
  .queue { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px; background: var(--panel); overflow: hidden; }
  .queue-head { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: none; border: none; color: var(--text); font: inherit; cursor: pointer; text-align: left; }
  .queue-head:hover { background: var(--panel2); }
  .qcount { font-family: var(--mono); font-weight: 700; font-size: 15px; min-width: 28px; text-align: center; background: var(--panel2); border-radius: 6px; padding: 2px 6px; }
  .qcount.zero { color: var(--mute); }
  .qcount:not(.zero) { color: var(--warn); }
  .qlabel { font-weight: 500; }
  .qhint { color: var(--mute); font-size: 12px; flex: 1; }
  .chev { color: var(--mute); transition: transform .15s; }
  .queue-head[aria-expanded="true"] .chev { transform: rotate(180deg); }
  .queue-body { border-top: 1px solid var(--border); max-height: 360px; overflow-y: auto; }
  .queue-body table { }
  .queue-body .ref { font-family: var(--mono); color: var(--mute); font-size: 11px; white-space: nowrap; }
  .queue-body .detail { color: var(--dim); }
  .empty { padding: 14px 16px; color: var(--mute); font-size: 13px; margin: 0; }
  .more { padding: 8px 16px; color: var(--mute); font-size: 12px; margin: 0; }
  .sev-error td:nth-child(2) { color: var(--err); }
  .sev-warning td:nth-child(2) { color: var(--warn); }
  .sev-info td:nth-child(2) { color: var(--mute); }
  .zones { font-family: var(--mono); font-size: 12px; color: var(--dim); padding: 12px 16px; }
  footer { max-width: 1100px; margin: 40px auto 0; padding: 20px 5vw; color: var(--mute); font-size: 12px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 800px) { .two-col { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <h1>xpf-cms · Dashboard</h1>
  <span class="meta">生成于 ${esc(generatedAt)} · ${esc(site.config.site.name)}</span>
</header>
<main>

  <div class="cards">
    <div class="card"><div class="n">${stats.items}</div><div class="l">全部条目</div></div>
    <div class="card ok"><div class="n">${stats.public}</div><div class="l">公开条目</div></div>
    <div class="card ${errors ? "err" : "ok"}"><div class="n">${errors}</div><div class="l">校验错误</div></div>
    <div class="card ${warnings ? "warn" : "ok"}"><div class="n">${warnings}</div><div class="l">校验警告</div></div>
    <div class="card"><div class="n">${infos}</div><div class="l">提示</div></div>
  </div>

  <h2>队列</h2>
  ${queueSection("draft", "草稿仍在 main", "state=draft/idea/review 但公网可访问，M6 后会消失", queues.draftOnMain)}
  ${queueSection("fresh", "新鲜度到期", "next_check ≤ 今天，需要人工/AI 复查", queues.freshnessDue)}
  ${queueSection("expiring", "轮换资产到期", "meta.rotation.expires_at 已过期或 3 天内到期", queues.expiringAssets)}
  ${queueSection("summary", "缺摘要", "meta.summary 为空，影响 llms.txt 质量", queues.missingSummary, 15)}
  ${queueSection("category", "缺分类", "meta.category 为空", queues.missingCategory, 15)}
  ${queueSection("noen", "无英文版", "DeepDive 文章只有中文", queues.noEnglish, 15)}
  ${queueSection("unreg", "未登记", "已发布但不在 content-index.json 里", queues.unregistered)}
  ${queueSection("metaerr", "meta 校验失败", "index.meta.json 不符合 schema v2", queues.metaErrors)}

  <div class="two-col">
    <div>
      <h2>各板块</h2>
      <div class="panel"><table><thead><tr><th>板块</th><th>条目</th><th>公开</th><th></th></tr></thead><tbody>${verticalRows}</tbody></table></div>
    </div>
    <div>
      <h2>校验发现分类</h2>
      <div class="panel"><table><thead><tr><th>code</th><th>severity</th><th>数量</th></tr></thead><tbody>${codeRows}</tbody></table></div>
    </div>
  </div>

  <h2>基础设施快照${infra.date ? ` · 截至备份 ${esc(infra.date)}${infra.delta ? "（较上次备份）" : ""}` : ""}</h2>
  ${infra.date ? `<div class="panel"><table><thead><tr><th>资源</th><th>数量</th><th>变化</th></tr></thead><tbody>${infraRows}</tbody></table>
    <div class="zones">zones: ${infra.zones.map(esc).join(" · ")}</div></div>`
    : `<div class="panel"><p class="empty">没找到 ~/Backups/xpf/&lt;date&gt;/inventory/ 快照，跑一次 ops/backup.sh 后这里会显示 Workers/D1/KV/… 的实况计数与漂移。</p></div>`}

  <h2>最近发布</h2>
  <div class="panel"><table><thead><tr><th>日期</th><th>标题</th><th>板块</th></tr></thead><tbody>${recentRows}</tbody></table></div>

</main>
<footer>
  <span>由 <code>xpf build dashboard</code> 从 <a href="${esc(site.config.site.base_url)}/llms.txt">/llms.txt</a> 同一份数据生成 · 只读，不修改任何内容</span>
  <span><a href="https://github.com/fxp/xpf-cms" target="_blank" rel="noopener">github.com/fxp/xpf-cms</a></span>
</footer>
<script>
document.querySelectorAll('[data-toggle]').forEach(function(btn){
  btn.addEventListener('click', function(){
    var body = document.getElementById(btn.getAttribute('data-toggle'));
    var open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    if (open) body.setAttribute('hidden', ''); else body.removeAttribute('hidden');
  });
});
</script>
</body>
</html>
`;
}
