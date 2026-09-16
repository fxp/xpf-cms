import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { MetaV2, type Meta } from "./schema.ts";
import type { XpfConfig } from "./config.ts";

export interface RegistryEntry { id: string; type: string; slug: string; date?: string; title?: string; status?: string; ep?: number; superseded_by?: string; removed_date?: string; }
export interface Item {
  ref: string;                 // "deepdive/foo" | "buzzwords/102"
  type: string;
  slug: string;
  dir: string;                 // absolute
  relDir: string;              // relative to site root
  urlPath: string;             // "/deepdive/foo/" or full URL
  meta: Meta | null;
  rawMeta: any | null;
  metaError: string | null;
  hasIndexHtml: boolean;
  hasIndexMd: boolean;
  hasLlms: boolean;
  registry: RegistryEntry | null;
  id: string | null;
  buzz?: any;                  // buzzwords/data/index.json entry
  page?: string;               // registry slug resolved to a single .html page (not a dir)
  redirect?: string;           // registry slug served by a _redirects rule
  moved?: string;              // registry slug found under a different vertical (stale registry type)
}
export interface Site { root: string; config: XpfConfig; contentIndex: any; items: Item[]; }

function walkMetaDirs(base: string, maxDepth: number): string[] {
  const out: string[] = [];
  const rec = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    let ents: string[] = [];
    try { ents = readdirSync(d); } catch { return; }
    if (ents.includes("index.meta.json")) out.push(d);
    for (const e of ents) {
      if (e.startsWith(".") || e === "node_modules" || e === "_data" || e === "slides" || e === "materials" || e === "assets" || e === "images" || e === "promo") continue;
      const p = path.join(d, e);
      try { if (statSync(p).isDirectory()) rec(p, depth + 1); } catch {}
    }
  };
  rec(base, 0);
  return out;
}

/** Non-index "<basename>.meta.json" files: legacy topic-child articles that share
 * their basename with a co-located "<basename>.html" instead of using index.html.
 * e.g. live/neolab/andon-labs.meta.json + andon-labs.html, or
 * deepdive/silicon-valley-politicians/karp-22-beliefs.meta.json + karp-22-beliefs.html. */
function walkTopicChildMetaFiles(base: string, maxDepth: number): { file: string; dir: string; basename: string }[] {
  const out: { file: string; dir: string; basename: string }[] = [];
  const rec = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    let ents: string[] = [];
    try { ents = readdirSync(d); } catch { return; }
    for (const e of ents) {
      if (e.startsWith(".") || e === "node_modules" || e === "_data" || e === "slides" || e === "materials" || e === "assets" || e === "images" || e === "promo") continue;
      const p = path.join(d, e);
      let isDir = false; try { isDir = statSync(p).isDirectory(); } catch { continue; }
      if (isDir) { rec(p, depth + 1); continue; }
      if (e.endsWith(".meta.json") && e !== "index.meta.json") {
        const basename = e.slice(0, -".meta.json".length);
        if (existsSync(path.join(d, basename + ".html"))) out.push({ file: p, dir: d, basename });
      }
    }
  };
  rec(base, 0);
  return out;
}

export function loadSite(root: string, config: XpfConfig): Site {
  const contentIndex = JSON.parse(readFileSync(path.join(root, "config/content-index.json"), "utf8"));
  const registryByRef = new Map<string, RegistryEntry>();
  for (const it of contentIndex.items as RegistryEntry[]) {
    const key = it.type === "buzzwords" ? `buzzwords/${it.ep ?? it.slug}` : `${it.type}/${it.slug}`;
    registryByRef.set(key, it);
  }
  const items = new Map<string, Item>();
  const topicChildScannedBases = new Set<string>();   // avoid rescanning a dir shared by two verticals (e.g. research also walks deepdive/)
  const urlFor = (type: string, slug: string) => {
    const v = config.verticals[type]; const pre = v?.url_prefix ?? `/${type}/`;
    return `${pre}${slug}/`;
  };

  for (const [type, v] of Object.entries(config.verticals)) {
    if (v.federated) continue;
    for (const d of v.dirs) {
      const base = path.join(root, d);
      if (!existsSync(base)) continue;
      for (const dir of walkMetaDirs(base, 3)) {
        let raw: any = null, meta: Meta | null = null, err: string | null = null;
        try { raw = JSON.parse(readFileSync(path.join(dir, "index.meta.json"), "utf8")); } catch (e: any) { err = `invalid JSON: ${e.message}`; }
        if (raw) {
          if (raw.type && raw.type !== type) continue;             // e.g. research items living under deepdive/
          if (!raw.type && type !== "deepdive" && d === "deepdive") continue;
          const r = MetaV2.safeParse(raw);
          if (r.success) meta = r.data; else err = r.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        }
        const rel = path.relative(root, dir);
        const slug = raw?.slug ?? path.basename(dir);
        const ref = `${type}/${slug}`;
        if (items.has(ref)) continue;
        items.set(ref, {
          ref, type, slug, dir, relDir: rel, urlPath: urlFor(type, path.relative(base, dir).split(path.sep).join("/")),
          meta, rawMeta: raw, metaError: err,
          hasIndexHtml: existsSync(path.join(dir, "index.html")),
          hasIndexMd: existsSync(path.join(dir, "index.md")),
          hasLlms: existsSync(path.join(dir, "llms.txt")),
          registry: registryByRef.get(ref) ?? null,
          id: registryByRef.get(ref)?.id ?? null,
        });
      }

      // topic-child articles: <basename>.meta.json + <basename>.html, not under an index.* dir
      // — skip dirs another vertical already scanned (e.g. research.dirs includes "deepdive", which deepdive itself owns)
      if (topicChildScannedBases.has(base)) continue;
      topicChildScannedBases.add(base);
      for (const tc of walkTopicChildMetaFiles(base, 3)) {
        let raw: any = null, meta: Meta | null = null, err: string | null = null;
        try { raw = JSON.parse(readFileSync(tc.file, "utf8")); } catch (e: any) { err = `invalid JSON: ${e.message}`; }
        if (!raw) continue;
        const effType = raw.type ?? type;                     // legacy metas often omit type; inherit from vertical
        const slugField: string = raw.slug ?? tc.basename;
        const relDirFromBase = path.relative(base, tc.dir).split(path.sep).filter(Boolean).join("/");
        // candidate registry refs, most to least specific — legacy data used inconsistent conventions
        const candidates = [
          slugField.includes("/") ? `${effType}/${slugField}` : null,                                   // e.g. "neolab/storyline" already namespaced
          relDirFromBase ? `${effType}/${relDirFromBase}/${tc.basename}` : null,                         // dir-relative/basename
          `${effType}/${slugField}`,                                                                     // plain slug as authored in meta.json
        ].filter((x): x is string => !!x);
        const ref = candidates.find(c => registryByRef.has(c)) ?? candidates[candidates.length - 1];
        if (items.has(ref)) continue;
        const r = MetaV2.safeParse({ ...raw, type: effType, slug: slugField.includes("/") ? tc.basename : slugField, status: raw.status ?? "published" });
        if (r.success) meta = r.data; else err = r.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        // verified-real URL: CF Pages 308-strips ".html", so the reachable URL is exactly the file path minus extension
        const urlPath = `${v.url_prefix}${relDirFromBase ? relDirFromBase + "/" : ""}${tc.basename}`;
        items.set(ref, {
          ref, type: effType, slug: tc.basename, dir: tc.dir, relDir: path.relative(root, tc.dir), urlPath,
          meta, rawMeta: raw, metaError: err,
          hasIndexHtml: true, hasIndexMd: existsSync(path.join(tc.dir, tc.basename + ".md")),
          hasLlms: existsSync(path.join(tc.dir, tc.basename + ".llms.txt")),
          registry: registryByRef.get(ref) ?? null, id: registryByRef.get(ref)?.id ?? null,
          page: path.relative(root, path.join(tc.dir, tc.basename + ".html")),
        });
      }
    }
  }
  // buzzwords: no per-episode meta.json; source is data/index.json
  const bz = config.verticals.buzzwords;
  if (bz?.source && existsSync(path.join(root, bz.source))) {
    const eps = JSON.parse(readFileSync(path.join(root, bz.source), "utf8"));
    for (const ep of eps) {
      if (ep.cancelled || !ep.web) continue;
      const slug = String(ep.ep); const dir = path.join(root, "buzzwords", slug); const ref = `buzzwords/${slug}`;
      items.set(ref, {
        ref, type: "buzzwords", slug, dir, relDir: `buzzwords/${slug}`, urlPath: `/buzzwords/${slug}/`,
        meta: null, rawMeta: null, metaError: null,
        hasIndexHtml: existsSync(path.join(dir, "index.html")), hasIndexMd: existsSync(path.join(dir, "index.md")), hasLlms: existsSync(path.join(dir, "llms.txt")),
        registry: registryByRef.get(ref) ?? null, id: registryByRef.get(ref)?.id ?? null, buzz: ep,
      });
    }
  }
  // registry entries with no directory: resolve to a single page file or a _redirects rule, else flag
  let redirects = "";
  try { redirects = readFileSync(path.join(root, "_redirects"), "utf8"); } catch {}
  for (const [ref, r] of registryByRef) {
    if (items.has(ref)) continue;
    if (r.type === "roam") continue;
    const i = ref.indexOf("/"); const type = ref.slice(0, i); const slug = ref.slice(i + 1);
    const v = config.verticals[type];
    let page: string | undefined; let moved: string | undefined;
    const findPage = (base: string): string | undefined => {
      const cand = [path.join(base, slug + ".html"), path.join(base, slug, "index.html")];
      let hit = cand.find(c => existsSync(c));
      if (!hit) { try { for (const sub of readdirSync(base)) { const c = path.join(base, sub, slug + ".html"); if (existsSync(c)) { hit = c; break; } } } catch {} }
      return hit;
    };
    for (const d of v?.dirs ?? []) { const hit = findPage(path.join(root, d)); if (hit) { page = path.relative(root, hit); break; } }
    if (!page) for (const [ot, ov] of Object.entries(config.verticals)) { if (ot === type || ov.federated) continue; for (const d of ov.dirs) { const hit = findPage(path.join(root, d)); if (hit) { moved = path.relative(root, hit); break; } } if (moved) break; }
    const urlPath = v?.url_prefix ? `${v.url_prefix}${slug}` : `/${type}/${slug}`;
    const rule = redirects.split("\n").find(l => l.trim().startsWith(urlPath + " ") || l.trim().startsWith(urlPath + "/ ") || l.trim().startsWith(urlPath + "/* "));
    items.set(ref, { ref, type, slug, dir: page ? path.join(root, path.dirname(page)) : "", relDir: page ? path.dirname(page) : "",
      urlPath: page ? "/" + page.replace(/\/index\.html$/, "/") : urlFor(type, slug), meta: null, rawMeta: null, metaError: null,
      hasIndexHtml: !!page, hasIndexMd: false, hasLlms: false, registry: r, id: r.id, page, moved, redirect: rule?.trim().split(/\s+/)[1] });
  }
  return { root, config, contentIndex, items: [...items.values()] };
}

export function itemTitle(it: Item): string {
  const m = it.meta ?? it.rawMeta;
  if (m?.title) { const lang = m.primary_language ?? "zh"; return m.title[lang] ?? Object.values(m.title).find(Boolean) as string ?? it.slug; }
  if (it.buzz?.title) return it.buzz.title;
  return it.registry?.title ?? it.slug;
}
export function itemDate(it: Item): string | undefined {
  return it.meta?.first_published ?? it.rawMeta?.first_published ?? it.buzz?.date ?? it.registry?.date;
}
export function itemSummary(it: Item): string | undefined {
  return it.meta?.summary ?? it.rawMeta?.summary ?? it.buzz?.oneliner ?? undefined;
}
export function itemState(it: Item): string {
  return it.meta?.status ?? it.rawMeta?.status ?? (it.buzz ? "published" : (it.registry?.status ?? "published"));
}
export function isPublic(it: Item): boolean {
  const s = itemState(it); const vis = it.meta?.visibility ?? "public";
  return (s === "published" || s === "updated") && vis === "public" && it.hasIndexHtml;
}
export function absUrl(site: Site, it: Item): string {
  return it.urlPath.startsWith("http") ? it.urlPath : site.config.site.base_url + it.urlPath;
}
