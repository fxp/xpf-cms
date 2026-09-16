import { existsSync } from "node:fs";
import path from "node:path";
import { V1_REQUIRED } from "./schema.ts";
import { itemState, type Site } from "./site.ts";

export type Severity = "error" | "warning" | "info";
export interface Finding { severity: Severity; code: string; ref: string; message: string; }

/** Registry entries with no local directory *by design* — either an external link
 * (e.g. a Skill hosted in someone else's repo) or a URL owned by a Cloudflare Worker
 * route rather than a file in this repo. Recorded here (not in the site's own
 * content-index.json) so the validator stays accurate without touching content the
 * site's own tooling depends on. */
const KNOWN_NO_DIR = new Set<string>(["apps/westniuworld", "skills/gongwen-gbt9704"]);

export function validateSite(site: Site): { findings: Finding[]; stats: Record<string, number> } {
  const f: Finding[] = [];
  const push = (severity: Severity, code: string, ref: string, message: string) => f.push({ severity, code, ref, message });

  // 1. duplicate ids per type in content-index
  const seen = new Map<string, string[]>();
  let noId = 0;
  for (const it of site.contentIndex.items) {
    if (it.id === undefined || it.id === null) { noId++; continue; }
    const k = `${it.type}:${it.id}`; seen.set(k, [...(seen.get(k) ?? []), it.slug ?? String(it.ep)]);
  }
  if (noId) push("info", "registry-no-id", "content-index", `${noId} registry entries have no id (landscape/live are not id-tracked)`);
  for (const [k, slugs] of seen) if (slugs.length > 1) push("error", "id-duplicate", k, `id ${k} assigned to ${slugs.length} items: ${slugs.join(", ")}`);

  // 2. counters vs max id
  const maxId = new Map<string, number>();
  for (const it of site.contentIndex.items) { const n = parseInt(it.id, 10); if (!isNaN(n)) maxId.set(it.type, Math.max(maxId.get(it.type) ?? 0, n)); }
  for (const [type, c] of Object.entries(site.contentIndex.counters as Record<string, number>)) {
    const m = maxId.get(type) ?? 0; if (m > c) push("error", "counter-behind", type, `counter ${c} < max id ${m}`);
  }

  const stats: Record<string, number> = { items: site.items.length, public: 0, draft_on_main: 0, no_meta: 0, meta_error: 0, no_index_html: 0, no_markdown_face: 0, no_summary: 0, unregistered: 0, missing_dir: 0 };
  for (const it of site.items) {
    const v = site.config.verticals[it.type];
    if (it.page && !it.rawMeta) { push("warning", "registry-page-not-dir", it.ref, `registry slug resolves to a single page ${it.page} (topic_dir child); no meta.json of its own`); continue; }
    if (KNOWN_NO_DIR.has(it.ref)) { push("info", "registry-known-external", it.ref, "no local directory by design (external link or Worker-route-owned URL)"); continue; }
    if (it.registry?.status === "removed") { push("info", "registry-removed-tombstone", it.ref, it.registry.superseded_by ? `removed, superseded by ${it.registry.superseded_by}` : "removed, kept for history"); continue; }
    if (it.moved) { push("warning", "registry-moved", it.ref, `registry says ${it.type} but the page now lives at ${it.moved} (stale type/slug in content-index)`); continue; }
    if (it.redirect) { push("info", "registry-redirect-only", it.ref, `served by _redirects → ${it.redirect}; no local directory`); continue; }
    if (!it.dir) {
      const st = it.registry?.status;
      if (st === "removed") { push("info", "registry-removed-no-dir", it.ref, "status=removed and no directory — tombstone, expected"); continue; }
      stats.missing_dir++; push("error", "registry-missing-dir", it.ref, `registered in content-index (id ${it.id}) but no directory, page or redirect found`); continue;
    }
    if (it.type !== "buzzwords" && !it.rawMeta) { stats.no_meta++; push("error", "meta-missing", it.ref, "index.meta.json missing"); }
    if (it.metaError) { stats.meta_error++; push("error", "meta-invalid", it.ref, it.metaError); }
    if (it.rawMeta && it.rawMeta.slug && it.rawMeta.slug !== path.basename(it.dir) && !it.rawMeta.topic_dir) push("warning", "slug-mismatch", it.ref, `meta.slug "${it.rawMeta.slug}" != dir "${path.basename(it.dir)}"`);
    if (it.rawMeta && !it.rawMeta.type) push("warning", "type-missing", it.ref, "meta.type missing (v1 legacy)");
    if (!it.hasIndexHtml && it.type !== "group") { stats.no_index_html++; push("warning", "index-html-missing", it.ref, "no index.html (coming soon / archived md only?)"); }
    const state = itemState(it);
    if (state === "draft" || state === "idea" || state === "review") { stats.draft_on_main++; push("warning", "draft-on-main", it.ref, `state=${state} lives on main and is publicly fetchable at ${it.urlPath}`); }
    if (it.rawMeta) for (const k of V1_REQUIRED) if (it.rawMeta[k] === undefined || it.rawMeta[k] === null) { if (k === "summary") stats.no_summary++; push(k === "summary" ? "warning" : "info", `field-missing:${k}`, it.ref, `meta.${k} missing`); }
    if (it.rawMeta?.first_published && it.rawMeta?.last_updated && it.rawMeta.last_updated < it.rawMeta.first_published) push("warning", "dates-inverted", it.ref, `last_updated ${it.rawMeta.last_updated} < first_published ${it.rawMeta.first_published}`);
    if (v && v.indexed !== false && !v.federated && it.type !== "buzzwords" && !it.registry && (state === "published" || state === "updated")) { stats.unregistered++; push("warning", "registry-unregistered", it.ref, "published item not in content-index.json"); }
    if (!it.hasIndexMd && it.hasIndexHtml) stats.no_markdown_face++;
    if ((state === "published" || state === "updated") && (it.meta?.visibility ?? "public") === "public" && it.hasIndexHtml) stats.public++;
    if (it.type === "group" && it.rawMeta && !it.rawMeta.rotation && existsSync(path.join(it.dir, "qr.jpg"))) push("info", "rotation-missing", it.ref, "has qr.jpg but no rotation block");
  }
  return { findings: f, stats };
}

export function renderReport(site: Site, res: ReturnType<typeof validateSite>, date: string): string {
  const by = (s: Severity) => res.findings.filter(x => x.severity === s);
  const byCode = new Map<string, Finding[]>();
  for (const x of res.findings) byCode.set(x.code, [...(byCode.get(x.code) ?? []), x]);
  const lines: string[] = [];
  lines.push(`# xpf validate · ${date}`, "", `site: ${site.root}`, "");
  lines.push("## 统计", "", "| 指标 | 值 |", "|---|---|");
  for (const [k, v] of Object.entries(res.stats)) lines.push(`| ${k} | ${v} |`);
  lines.push(`| errors | ${by("error").length} |`, `| warnings | ${by("warning").length} |`, `| info | ${by("info").length} |`, "");
  lines.push("## 按类型", "", "| type | 条目 | public |", "|---|---|---|");
  const types = new Map<string, [number, number]>();
  for (const it of site.items) { const t = types.get(it.type) ?? [0, 0]; t[0]++; const s = itemState(it); if ((s === "published" || s === "updated") && it.hasIndexHtml) t[1]++; types.set(it.type, t); }
  for (const [t, [n, p]] of [...types].sort()) lines.push(`| ${t} | ${n} | ${p} |`);
  lines.push("", "## 问题分组", "");
  for (const [code, xs] of [...byCode].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### ${code} · ${xs[0].severity} · ${xs.length}`, "");
    for (const x of xs.slice(0, 40)) lines.push(`- \`${x.ref}\` — ${x.message}`);
    if (xs.length > 40) lines.push(`- … 另 ${xs.length - 40} 条`);
    lines.push("");
  }
  return lines.join("\n");
}
