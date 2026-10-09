// planPublish: the single place that decides what a publish may commit, whether the
// resulting tree is acceptable, and what the commit looks like. Pure and runtime-neutral —
// the CLI (`xpf publish --dry-run`), CI and the cms Worker all call this same function.
import { MetaV2 } from "./schema.ts";
import type { XpfConfig } from "./config-types.ts";
import { OverlayView, matchesAny, type Bundle, type BundleChange, type FileView } from "./bundle.ts";

export type Verb = "add" | "update" | "remove";
export interface PublishIntent {
  /** "howto/skill-state" | "buzzwords/106" */
  ref: string;
  verb: Verb;
  summary?: string;
  /** "human" | "agent:claude-code" … recorded in the commit trailer */
  actor?: string;
  /** append [content-update] so the commit shows on the homepage calendar */
  calendar?: boolean;
  /** extra source paths this publish owns (e.g. `_redirects`, a sibling page) */
  also?: string[];
  /** override the item directory (default: first vertical dir where the item exists) */
  itemDir?: string;
  /** howto "coming soon" placeholders etc.: downgrade the not-published-state error to a warning */
  placeholder?: boolean;
  /** add a `Derive: pending` trailer (CI will regenerate derived files before deploy) */
  derive?: boolean;
}
export interface PublishFinding { severity: "error" | "warning" | "info"; code: string; path?: string; message: string; }
export interface PublishPlan {
  ok: boolean;
  ref: string; type: string; slug: string; verb: Verb;
  itemDir: string | null;
  id: string | null;
  findings: PublishFinding[];
  /** The changes to commit: owned bundle changes, with the registry rewritten as a semantic merge onto base. */
  changes: BundleChange[];
  /** Paths dropped because CI regenerates them. */
  skippedDerived: string[];
  commit: { subject: string; body: string; message: string };
}

const SUBJECT_TYPE: Record<Verb, string> = { add: "feat", update: "fix", remove: "chore" };
const PUBLISHABLE = new Set(["published", "updated"]);

export function parseRef(ref: string): { type: string; slug: string } {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) throw new Error(`bad ref "${ref}" (expected <type>/<slug>)`);
  return { type: ref.slice(0, i), slug: ref.slice(i + 1) };
}

/** Predicate for the source paths one publish owns: the item dir, the id registry (id-tracked types only),
 * the vertical's listing files, and any explicit extras. */
export function ownershipFor(config: XpfConfig, type: string, itemDir: string, also: string[] = []): (path: string) => boolean {
  const v = config.verticals[type];
  const listing = new Set(v?.listing ?? []);
  const extras = new Set(also);
  const registry = v && v.counter !== null ? config.publish.registry : null;
  return (p: string) => p.startsWith(itemDir + "/") || p === registry || listing.has(p) || extras.has(p);
}
/** Paths a bundle may carry that are neither owned nor an error: CI-generated, silently dropped. */
export function isDerived(config: XpfConfig, p: string): boolean { return matchesAny(config.publish.derived, p); }

function registryKey(e: any): string {
  return e.type === "buzzwords" ? `buzzwords/${e.ep ?? e.slug}` : `${e.type}/${e.slug}`;
}

function tryJson(text: string | null): { ok: true; value: any } | { ok: false; error: string } {
  if (text === null) return { ok: false, error: "missing" };
  try { return { ok: true, value: JSON.parse(text) }; } catch (e: any) { return { ok: false, error: e.message }; }
}

/** Base registry + only this ref's entry (and its counter) taken from the working registry. */
export function mergeRegistry(base: any, working: any, ref: string, counter: string | null): { merged: any; foreignChanged: number } {
  const merged = JSON.parse(JSON.stringify(base));
  const mine = (working.items as any[]).find(e => registryKey(e) === ref);
  if (mine) {
    const idx = (merged.items as any[]).findIndex(e => registryKey(e) === ref);
    if (idx >= 0) merged.items[idx] = mine; else merged.items.push(mine);
    if (counter) {
      const n = parseInt(mine.id, 10);
      if (!isNaN(n)) merged.counters[counter] = Math.max(merged.counters?.[counter] ?? 0, n);
    }
  }
  // how many *other* entries differ between working and base (informational only: they stay local)
  const baseByKey = new Map((base.items as any[]).map(e => [registryKey(e), JSON.stringify(e)]));
  let foreignChanged = 0;
  for (const e of working.items as any[]) {
    const k = registryKey(e);
    if (k !== ref && baseByKey.get(k) !== JSON.stringify(e)) foreignChanged++;
  }
  return { merged, foreignChanged };
}

export async function planPublish(base: FileView, bundle: Bundle, intent: PublishIntent, config: XpfConfig): Promise<PublishPlan> {
  const findings: PublishFinding[] = [];
  const push = (severity: PublishFinding["severity"], code: string, message: string, path?: string) => findings.push({ severity, code, message, path });
  const { type, slug } = parseRef(intent.ref);
  const vertical = config.verticals[type];
  const registryPath = config.publish.registry;
  const overlay = new OverlayView(base, bundle);
  const empty = (): PublishPlan => ({ ok: false, ref: intent.ref, type, slug, verb: intent.verb, itemDir: null, id: null, findings, changes: [], skippedDerived: [], commit: { subject: "", body: "", message: "" } });

  if (!vertical) { push("error", "unknown-type", `unknown vertical "${type}"`); return empty(); }
  if (vertical.federated) { push("error", "federated-type", `${type} lives in its own repo; register it with roam_register instead`); return empty(); }

  // --- item directory ---------------------------------------------------------------------------
  let itemDir: string | null = intent.itemDir ?? null;
  if (!itemDir) {
    const candidates = type === "buzzwords" ? [`buzzwords/${slug}`] : vertical.dirs.map(d => `${d}/${slug}`);
    for (const view of intent.verb === "remove" ? [base, overlay] : [overlay, base]) {
      for (const c of candidates) {
        if (await view.exists(`${c}/index.html`) || await view.exists(`${c}/index.meta.json`)) { itemDir = c; break; }
      }
      if (itemDir) break;
    }
  }
  if (!itemDir) { push("error", "item-dir-missing", `no directory found for ${intent.ref} (looked in ${vertical.dirs.join(", ")}); pass --item-dir if it lives elsewhere`); return empty(); }

  // --- partition the bundle by ownership --------------------------------------------------------
  const counter = vertical.counter;
  const owned = ownershipFor(config, type, itemDir, intent.also);
  const changes: BundleChange[] = [];
  const skippedDerived: string[] = [];
  for (const c of bundle.changes) {
    if (matchesAny(config.publish.forbidden, c.path)) { push("error", "forbidden-path", `${c.path} may never be part of a content publish`, c.path); continue; }
    if (owned(c.path)) { changes.push(c); continue; }
    if (matchesAny(config.publish.derived, c.path)) { skippedDerived.push(c.path); continue; }
    push("error", "unowned-path", `${c.path} is not owned by ${intent.ref} (item dir, registry, ${type} listing); add it with --also if intended`, c.path);
  }
  if (skippedDerived.length) push("info", "derived-skipped", `${skippedDerived.length} derived file(s) not sent; CI regenerates them`);

  // --- registry: semantic merge onto base --------------------------------------------------------
  let id: string | null = null;
  if (counter !== null) {
    const baseReg = tryJson(await base.read(registryPath));
    const workReg = tryJson(await overlay.read(registryPath));
    if (!baseReg.ok) push("error", "registry-unreadable", `${registryPath} on base: ${baseReg.error}`, registryPath);
    else if (!workReg.ok) push("error", "registry-unreadable", `${registryPath} in working tree: ${workReg.error}`, registryPath);
    else {
      const baseEntry = (baseReg.value.items as any[]).find(e => registryKey(e) === intent.ref) ?? null;
      const live = baseEntry && baseEntry.status !== "removed" ? baseEntry : null;
      const mine = (workReg.value.items as any[]).find(e => registryKey(e) === intent.ref) ?? null;
      id = mine?.id ?? baseEntry?.id ?? null;
      if (intent.verb === "add") {
        if (live) push("error", "already-published", `${intent.ref} is already registered (id ${live.id}); use update`, registryPath);
        if (!mine) push("error", "registry-entry-missing", `${registryPath} has no entry for ${intent.ref}`, registryPath);
      } else if (!baseEntry) {
        push("error", "not-published", `${intent.ref} is not registered on base; use add`, registryPath);
      } else if (intent.verb === "remove" && (mine?.status !== "removed" || !mine?.removed_date)) {
        push("error", "remove-not-marked", `registry entry for ${intent.ref} must have status "removed" and removed_date`, registryPath);
      }
      if (mine) {
        if (!/^\d{4}$/.test(String(mine.id))) push("error", "id-format", `id "${mine.id}" is not a 4-digit string`, registryPath);
        const dup = (workReg.value.items as any[]).filter(e => e.type === type && e.id === mine.id && registryKey(e) !== intent.ref);
        if (dup.length) push("error", "id-duplicate", `id ${mine.id} is also used by ${dup.map(registryKey).join(", ")}`, registryPath);
        const n = parseInt(mine.id, 10);
        if (intent.verb === "add" && !isNaN(n)) {
          const baseCounter = baseReg.value.counters?.[counter] ?? 0;
          if (n <= baseCounter && !live && !baseEntry) push("error", "id-not-fresh", `id ${mine.id} is not above the current ${counter} counter (${baseCounter}); another publish may have landed — re-run`, registryPath);
        }
        if (type === "buzzwords" && String(mine.ep) !== slug) push("error", "ep-mismatch", `registry ep ${mine.ep} != ${slug}`, registryPath);
      }
      if (baseReg.ok && workReg.ok && mine) {
        const { merged, foreignChanged } = mergeRegistry(baseReg.value, workReg.value, intent.ref, counter);
        if (foreignChanged) push("info", "registry-foreign-entries", `${foreignChanged} other registry entr${foreignChanged === 1 ? "y" : "ies"} changed locally were not included (publish them separately)`, registryPath);
        const text = JSON.stringify(merged, null, 2) + "\n";
        const i = changes.findIndex(c => c.path === registryPath);
        if (text === await base.read(registryPath)) {
          if (i >= 0) changes.splice(i, 1);                 // nothing of this ref's registry state changed
        } else {
          const change: BundleChange = { path: registryPath, op: "put", encoding: "utf8", content: text, size: new TextEncoder().encode(text).length };
          if (i >= 0) changes[i] = change; else changes.push(change);
        }
      }
    }
  }

  // --- item content ---------------------------------------------------------------------------
  if (intent.verb !== "remove") {
    const html = await overlay.read(`${itemDir}/index.html`);
    if (html === null && !(await overlay.exists(`${itemDir}/index.html`))) push("error", "index-html-missing", `${itemDir}/index.html does not exist`, `${itemDir}/index.html`);
    if (html && /冯晓平/.test(html)) push("error", "author-name", "页面里出现了“冯晓平”，作者名是“冯小平”", `${itemDir}/index.html`);

    if (type !== "buzzwords") {
      const metaPath = `${itemDir}/index.meta.json`;
      const raw = tryJson(await overlay.read(metaPath));
      if (!raw.ok) push("error", "meta-invalid", raw.error === "missing" ? "index.meta.json missing" : `invalid JSON: ${raw.error}`, metaPath);
      else {
        const r = MetaV2.safeParse(raw.value);
        if (!r.success) push("error", "meta-invalid", r.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "), metaPath);
        const m = raw.value;
        if (m.type && m.type !== type) push("error", "meta-type-mismatch", `meta.type "${m.type}" != ${type}`, metaPath);
        if (m.slug && m.slug !== slug && !m.topic_dir && !slug.endsWith(`/${m.slug}`)) push("warning", "slug-mismatch", `meta.slug "${m.slug}" != "${slug}"`, metaPath);
        if (m.status && !PUBLISHABLE.has(m.status)) push(intent.placeholder ? "warning" : "error", "not-published-state", `meta.status is "${m.status}"; only published/updated may go to main`, metaPath);
        if (m.visibility === "private" || m.visibility === "internal") push("error", "not-public", `meta.visibility "${m.visibility}" cannot be published to the public site`, metaPath);
        if (intent.verb === "update") {
          const baseMeta = tryJson(await base.read(metaPath));
          if (baseMeta.ok && typeof baseMeta.value.current_version === "number" && m.current_version === baseMeta.value.current_version)
            push("warning", "version-not-bumped", `current_version still ${m.current_version}; add a version_log entry for this change`, metaPath);
        }
      }
    }
    for (const l of vertical.listing ?? []) {
      const text = await overlay.read(l);
      if (text === null) continue;
      if (l.endsWith(".json")) {
        const j = tryJson(text);
        if (!j.ok) push("error", "listing-invalid", `${l}: ${j.error}`, l);
        else if (type === "buzzwords" && !(j.value as any[]).some(e => String(e.ep) === slug)) push("error", "listing-missing-item", `${l} has no entry for EP.${slug}`, l);
      } else if (!text.includes(slug)) push("warning", "listing-missing-slug", `${l} does not mention "${slug}"`, l);
    }
  } else {
    for (const l of vertical.listing ?? []) {
      const text = await overlay.read(l);
      if (text !== null && !l.endsWith(".json") && text.includes(`/${slug}/`) && !/class="[^"]*\bremoved\b/.test(text))
        push("warning", "listing-still-links", `${l} still links to ${slug}; hide or delete its entry`, l);
    }
  }

  if (!changes.some(c => c.path !== registryPath)) push("error", "no-changes", `nothing to publish for ${intent.ref}: no owned file changed`);
  const total = changes.reduce((s, c) => s + (c.size ?? c.content?.length ?? 0), 0);
  if (total > 50 * 1024 * 1024) push("warning", "bundle-large", `bundle is ${(total / 1048576).toFixed(1)} MB; large media belongs in R2`);

  // --- commit message ---------------------------------------------------------------------------
  const label = type === "buzzwords" ? `EP.${slug}` : slug;
  const idTag = id ? ` [${vertical.id_prefix}·${id}]` : "";
  const subject = `${SUBJECT_TYPE[intent.verb]}(${type}): ${intent.verb === "add" && type === "buzzwords" ? "publish" : intent.verb} ${label}${idTag}${intent.calendar ? " [content-update]" : ""}`;
  const trailers = ["Published-via: xpf-cms", `Artifact: ${intent.ref}`, `Actor: ${intent.actor ?? "human"}`, ...(intent.derive ? ["Derive: pending"] : [])];
  const body = [intent.summary?.trim(), trailers.join("\n")].filter(Boolean).join("\n\n");
  const message = `${subject}\n\n${body}\n`;

  return { ok: !findings.some(f => f.severity === "error"), ref: intent.ref, type, slug, verb: intent.verb, itemDir, id, findings, changes, skippedDerived, commit: { subject, body, message } };
}
