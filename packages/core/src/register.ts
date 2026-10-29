import type { XpfConfig } from "./config-types.ts";
import { parseRef } from "./publish.ts";

export interface RegisterOptions {
  /** title shown in the registry (adds only) */
  title: string;
  /** YYYY-MM-DD: the item's date (add) or the takedown date (remove) */
  date: string;
  remove?: boolean;
}
/** `id` is null for verticals whose registry entries carry no id (landscape, live). */
export interface RegisterResult { registry: any; id: string | null; action: "added" | "removed"; }

const pad4 = (n: number) => String(n).padStart(4, "0");
const keyOf = (e: any) => (e.type === "buzzwords" ? `buzzwords/${e.ep ?? e.slug}` : `${e.type}/${e.slug}`);

/**
 * The registry edit every publish needs, done once and the same way for every skill: allocate the next id
 * (add) or tombstone the entry (remove). Pure: takes the parsed config/content-index.json, returns a new one.
 */
export function registerEntry(registry: any, config: XpfConfig, ref: string, o: RegisterOptions): RegisterResult {
  const { type, slug } = parseRef(ref);
  const v = config.verticals[type];
  if (!v) throw new Error(`unknown vertical "${type}"`);
  if (v.federated) throw new Error(`${type} lives in its own repo; it is not registered here`);
  if (v.counter === null && !v.registered) throw new Error(`${type} items are not id-tracked in ${config.publish.registry}; nothing to register`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new Error(`date must be YYYY-MM-DD, got "${o.date}"`);
  const out = JSON.parse(JSON.stringify(registry));
  if (!Array.isArray(out.items) || typeof out.counters !== "object") throw new Error("registry has no items/counters");
  const existing = out.items.find((e: any) => keyOf(e) === ref);

  if (o.remove) {
    if (!existing) throw new Error(`${ref} is not in the registry`);
    if (existing.status === "removed") throw new Error(`${ref} is already removed`);
    existing.status = "removed";
    existing.removed_date = o.date;
    return { registry: out, id: existing.id ?? null, action: "removed" };
  }

  if (existing) throw new Error(existing.status === "removed"
    ? `${ref} was removed${existing.id ? ` (id ${existing.id})` : ""}; pick a new slug instead of reusing it`
    : `${ref} is already registered${existing.id ? ` (id ${existing.id})` : ""}; use update, not register`);
  if (!o.title.trim()) throw new Error("title is required");

  let entry: any, id: string | null;
  if (v.counter === null) {
    // id-less entries (landscape, live): the registry only lists them, in the shape the existing rows have
    id = null;
    entry = { type, slug, date: o.date, title: o.title };
  } else if (type === "buzzwords") {
    const ep = Number(slug);
    if (!Number.isInteger(ep) || ep <= 0) throw new Error(`buzzwords ref must be buzzwords/<episode number>, got "${ref}"`);
    id = pad4(ep);
    entry = { id, type, ep, date: o.date, title: o.title };
    out.counters[v.counter] = Math.max(out.counters[v.counter] ?? 0, ep);
  } else {
    const next = (out.counters[v.counter] ?? 0) + 1;
    id = pad4(next);
    entry = { id, type, slug, date: o.date, title: o.title };
    out.counters[v.counter] = next;
  }
  out.items.push(entry);
  return { registry: out, id, action: "added" };
}
