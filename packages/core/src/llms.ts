import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { htmlToMarkdown } from "./markdown.ts";
import { absUrl, isPublic, itemDate, itemState, itemSummary, itemTitle, type Item, type Site } from "./site.ts";

export interface BuildOpts { outDir: string; only?: string[]; maxFullChars?: number; skipExisting?: boolean; }
export interface BuildStats { items: number; mdWritten: number; llmsWritten: number; llmsSkippedAuthored: number; verticalIndexes: number; fullChars: number; byMethod: Record<string, number>; }

const fm = (kv: Record<string, unknown>) => "---\n" + Object.entries(kv).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : typeof v === "string" && /[:#\n"]/.test(v) ? JSON.stringify(v) : v}`).join("\n") + "\n---\n";
const oneLine = (s: string | undefined, n = 240) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n).trimEnd() + "…" : t; };
const out = (opts: BuildOpts, rel: string, text: string) => { const p = path.join(opts.outDir, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); };

function idLabel(it: Item, site: Site): string { const v = site.config.verticals[it.type]; return it.id ? `${v?.id_prefix ?? it.type.toUpperCase()}·${it.id}` : (it.buzz ? `EP.${it.slug}` : ""); }

function itemLlmsTxt(site: Site, it: Item, mdChars: number | null): string {
  const m: any = it.meta ?? it.rawMeta ?? {};
  const langs: string[] = m.languages ?? ["zh"];
  const lines = [
    `# ${itemTitle(it)}`, "",
    `URL: ${absUrl(site, it)}`,
    `Markdown: ${absUrl(site, it)}index.md`,
    `类型: ${site.config.verticals[it.type]?.label ?? it.type}${idLabel(it, site) ? " · " + idLabel(it, site) : ""}`,
    `日期: ${itemDate(it) ?? "?"}${m.last_updated && m.last_updated !== m.first_published ? ` · 更新 ${m.last_updated}` : ""}${m.current_version ? ` · v${m.current_version}` : ""}`,
    `语言: ${langs.join(", ")}${langs.includes("en") ? ` · 英文版 ${absUrl(site, it)}index.en.html` : ""}`,
    `作者: ${m.author ?? site.config.site.author}`,
  ];
  if (m.category) lines.push(`分类: ${m.category}`);
  if (m.tags?.length) lines.push(`标签: ${m.tags.join(", ")}`);
  if (it.type === "predictions" && m.statement) lines.push(`预测: ${m.statement}`, `判定期限: ${m.target_date ?? "?"} · 当前判定: ${m.verification?.verdict ?? m.verification ?? "pending"}`);
  if (it.buzz?.notion) lines.push(`Notion 信源: ${it.buzz.notion}`);
  if (mdChars) lines.push(`正文: 约 ${mdChars} 字符（index.md）`);
  lines.push("", "## 摘要", "", itemSummary(it) ? oneLine(itemSummary(it), 600) : "（无摘要，请读 index.md）", "");
  return lines.join("\n");
}

export function buildMarkdownFace(site: Site, opts: BuildOpts): BuildStats {
  const stats: BuildStats = { items: 0, mdWritten: 0, llmsWritten: 0, llmsSkippedAuthored: 0, verticalIndexes: 0, fullChars: 0, byMethod: {} };
  const maxFull = opts.maxFullChars ?? 80_000;
  const pub = site.items.filter(it => isPublic(it) && (!opts.only || opts.only.includes(it.type)) && site.config.verticals[it.type]?.markdown_source !== "none");
  const full: string[] = [];
  const byType = new Map<string, { it: Item; chars: number }[]>();
  for (const it of pub) {
    stats.items++;
    const html = readFileSync(path.join(it.dir, "index.html"), "utf8");
    const url = absUrl(site, it);
    const r = htmlToMarkdown(html, url);
    stats.byMethod[r.method] = (stats.byMethod[r.method] ?? 0) + 1;
    const m: any = it.meta ?? it.rawMeta ?? {};
    const md = fm({ title: itemTitle(it), url, type: it.type, id: idLabel(it, site) || undefined, date: itemDate(it), updated: m.last_updated !== m.first_published ? m.last_updated : undefined, version: m.current_version, lang: m.primary_language ?? "zh", languages: m.languages, tags: m.tags, category: m.category ?? undefined, summary: itemSummary(it) ? oneLine(itemSummary(it), 600) : undefined, source: `derived from index.html by xpf build (${r.method})`, generated: new Date().toISOString().slice(0, 10) }) + "\n" + r.markdown + "\n";
    out(opts, path.join(it.relDir, "index.md"), md); stats.mdWritten++;
    if (it.hasLlms && opts.skipExisting !== false) stats.llmsSkippedAuthored++; else { out(opts, path.join(it.relDir, "llms.txt"), itemLlmsTxt(site, it, r.chars)); stats.llmsWritten++; }
    byType.set(it.type, [...(byType.get(it.type) ?? []), { it, chars: r.chars }]);
    const body = r.chars > maxFull ? r.markdown.slice(0, maxFull) + `\n\n[… 截断，完整版见 ${url}index.md ]` : r.markdown;
    full.push(`# ${itemTitle(it)}\n\nURL: ${url}\n日期: ${itemDate(it) ?? "?"} · 类型: ${it.type}${m.tags?.length ? " · 标签: " + m.tags.join(", ") : ""}\n\n${body}`);
  }
  // per-vertical llms.txt
  for (const [type, arr] of byType) {
    const v = site.config.verticals[type]; if (v?.own_llms) continue;
    arr.sort((a, b) => (itemDate(b.it) ?? "").localeCompare(itemDate(a.it) ?? ""));
    const dates = arr.map(x => itemDate(x.it)).filter(Boolean).sort();
    const lines = [`# ${v?.label ?? type} · xiaopingfeng.com`, "", `> ${v?.description ?? ""}`, `> URL: ${site.config.site.base_url}${v?.url_prefix ?? "/" + type + "/"} · 共 ${arr.length} 条 · 覆盖 ${dates[0]} → ${dates[dates.length - 1]}`, `> 每条目录下有 index.md（Markdown 正文）与 llms.txt（摘要）；index.html 为读者版。`, "", "## 条目（按时间倒序）", ""];
    for (const { it } of arr) { const m: any = it.meta ?? it.rawMeta ?? {}; lines.push(`- [${itemTitle(it)}](${absUrl(site, it)}) · ${itemDate(it) ?? "?"}${m.category ? " · " + m.category : ""}${itemSummary(it) ? "\n  " + oneLine(itemSummary(it), 200) : ""}`); }
    out(opts, path.join(v?.dirs?.[0] ?? type, "llms.txt"), lines.join("\n") + "\n"); stats.verticalIndexes++;
  }
  // site llms.txt
  const s = site.config.site; const base = s.base_url;
  const total = pub.length;
  const L: string[] = [`# ${s.name}`, "", `> ${s.description}`, `> 作者：${s.author}（${s.author_handle}） · ${base} · 本文件生成于 ${new Date().toISOString().slice(0, 10)} · 公开条目 ${total} 条`, ""];
  L.push("## 给 Agent 的使用说明", "",
    `- 每个条目目录下都有 \`index.md\`（Markdown 正文，从读者版 HTML 派生）和 \`llms.txt\`（元数据与摘要）。例：${base}/deepdive/<slug>/index.md`,
    `- 全文合集：${base}/llms-full.txt（${total} 条拼接，单条超过 ${maxFull} 字符会截断并给出链接）。`,
    `- 结构化清单：${base}/config/site-manifest.json（每条 id/type/slug/title/date/tags/summary/url_path）；元数据 schema：${base}/config/meta.schema.json；面向 Agent 的站点说明：${base}/agents.txt。`,
    `- 各板块自有索引：见下方每个板块的 llms.txt 链接。`,
    `- 引用规范：文章内引用均带原始来源链接；转述请注明 URL 与日期。`, "");
  L.push("## 内容板块", "");
  const order = ["deepdive","buzzwords","research","predictions","landscape","live","training","howto","apps","skills","notes","roam"];
  for (const type of order) {
    const v = site.config.verticals[type]; if (!v || v.in_manifest === false) continue;
    const arr = byType.get(type) ?? [];
    const idxUrl = v.federated ? v.manifest_url : `${base}${v.url_prefix}llms.txt`;
    const listUrl = v.url_prefix.startsWith("http") ? v.url_prefix : base + v.url_prefix;
    L.push(`- **${v.label}** — ${v.description ?? ""} ${v.federated ? "（独立站点，联邦）" : `共 ${arr.length} 条`} · [入口](${listUrl}) · [索引](${idxUrl})`);
  }
  L.push("", "## 最近发布（20 条）", "");
  const recent = [...pub].sort((a, b) => (itemDate(b) ?? "").localeCompare(itemDate(a) ?? "")).slice(0, 20);
  for (const it of recent) L.push(`- ${itemDate(it)} · [${itemTitle(it)}](${absUrl(site, it)}) · ${site.config.verticals[it.type]?.label ?? it.type}`);
  const skills = byType.get("skills") ?? [];
  L.push("", "## Skills · Agent 技能专区", "", `入口 ${base}/apps/skills/ 。收录自研或验证过的 Claude Code / Agent Skill，每条给出用途与可安装的上游 SKILL.md。`);
  for (const { it } of skills) L.push(`- [${itemTitle(it)}](${absUrl(site, it)})${itemSummary(it) ? " — " + oneLine(itemSummary(it), 160) : ""}`);
  // fallback: skills listed inline on the section page (external repos) until they get their own artifact dirs
  try {
    const html = readFileSync(path.join(site.root, "apps/skills/index.html"), "utf8");
    const seenHref = new Set(skills.map(x => absUrl(site, x.it)));
    for (const m of html.matchAll(/<a[^>]+href="(https?:\/\/(?:github\.com|gist\.github\.com|huggingface\.co)[^"]+)"[^>]*>([^<]{2,120})<\/a>/g)) {
      if (seenHref.has(m[1])) continue; seenHref.add(m[1]);
      L.push(`- [${m[2].trim()}](${m[1]}) — 收录于 ${base}/apps/skills/`);
    }
  } catch {}
  if (L[L.length - 1].startsWith("入口 ")) L.push("（专区已建立，条目陆续收录中。）");
  L.push("", "## 站点能力（当前可用）", "", `- 静态 HTML，无需执行 JavaScript 即可抓取；每条 index.md / llms.txt 与 HTML 同目录。`, `- 预测板块的判定由 AI 定期联网核实，结果写在各条 llms.txt 的"当前判定"。`, `- 计划中（尚未上线，请勿依赖）：只读 MCP 端点、\`Accept: text/markdown\` 内容协商。`, "");
  out(opts, "llms.txt", L.join("\n"));
  const fullText = full.join("\n\n---\n\n") + "\n"; out(opts, "llms-full.txt", fullText); stats.fullChars = fullText.length;
  return stats;
}

/** Idempotently add a Markdown-face section to agents.txt */
export function patchAgentsTxt(siteRoot: string, opts: BuildOpts, base: string): boolean {
  const p = path.join(siteRoot, "agents.txt"); if (!existsSync(p)) return false;
  let t = readFileSync(p, "utf8");
  if (t.includes("## Markdown face")) return false;
  const block = `## Markdown face (llms.txt convention)\n\n    GET /llms.txt          site index for agents (verticals, recent items, skills)\n    GET /llms-full.txt     every public item's Markdown body, concatenated\n    GET /<type>/llms.txt   per-vertical index\n    GET /<type>/<slug>/index.md   Markdown body of one item (derived from index.html)\n    GET /<type>/<slug>/llms.txt   one item's metadata + summary\n\nAll generated by xpf build from index.meta.json + index.html; regenerate after\ncontent changes rather than editing by hand. Base URL: ${base}\n\n`;
  t = t.replace(/## Content verticals and URL patterns/, block + "## Content verticals and URL patterns");
  out(opts, "agents.txt", t); return true;
}
