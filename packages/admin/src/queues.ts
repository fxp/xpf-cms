import type { Finding } from "@xpf/core";
import { itemDate, itemTitle, absUrl, type Item, type Site } from "@xpf/core";

export interface QueueEntry { ref: string; title: string; url: string; detail: string; since?: string; }
export interface Queues {
  draftOnMain: QueueEntry[];
  freshnessDue: QueueEntry[];
  missingSummary: QueueEntry[];
  missingCategory: QueueEntry[];
  noEnglish: QueueEntry[];
  expiringAssets: QueueEntry[];
  unregistered: QueueEntry[];
  metaErrors: QueueEntry[];
}

const today = () => new Date().toISOString().slice(0, 10);

function entry(site: Site, it: Item, detail: string, since?: string): QueueEntry {
  return { ref: it.ref, title: itemTitle(it), url: it.dir ? absUrl(site, it) : "", detail, since };
}

export function buildQueues(site: Site, findings: Finding[]): Queues {
  const byRef = new Map<string, Item>();
  for (const it of site.items) byRef.set(it.ref, it);
  const t = today();

  const draftOnMain: QueueEntry[] = [];
  const missingSummary: QueueEntry[] = [];
  const missingCategory: QueueEntry[] = [];
  const unregistered: QueueEntry[] = [];
  const metaErrors: QueueEntry[] = [];
  for (const f of findings) {
    const it = byRef.get(f.ref);
    if (!it) continue;
    if (f.code === "draft-on-main") draftOnMain.push(entry(site, it, f.message));
    else if (f.code === "field-missing:summary") missingSummary.push(entry(site, it, "缺 summary"));
    else if (f.code === "field-missing:category") missingCategory.push(entry(site, it, "缺 category"));
    else if (f.code === "registry-unregistered") unregistered.push(entry(site, it, "已发布但未登记到 content-index"));
    else if (f.code === "meta-invalid") metaErrors.push(entry(site, it, f.message));
  }

  const freshnessDue: QueueEntry[] = [];
  const noEnglish: QueueEntry[] = [];
  const expiringAssets: QueueEntry[] = [];
  for (const it of site.items) {
    const m: any = it.meta ?? it.rawMeta;
    if (!m) continue;
    const state = m.status ?? "published";
    if (state !== "published" && state !== "updated") continue;
    if (m.next_check && m.next_check <= t) freshnessDue.push(entry(site, it, `到期复查：${m.next_check}`, m.next_check));
    if (it.type === "deepdive" && Array.isArray(m.languages) && m.languages.length === 1 && m.languages[0] === "zh") {
      noEnglish.push(entry(site, it, "只有中文版"));
    }
    if (m.rotation?.expires_at && m.rotation.expires_at <= t) {
      expiringAssets.push(entry(site, it, `轮换资产已过期：${m.rotation.asset} (${m.rotation.expires_at})`, m.rotation.expires_at));
    } else if (m.rotation?.expires_at) {
      const days = Math.round((new Date(m.rotation.expires_at).getTime() - Date.now()) / 86400000);
      if (days <= 3) expiringAssets.push(entry(site, it, `轮换资产 ${days} 天后到期：${m.rotation.asset}`, m.rotation.expires_at));
    }
  }

  const bySince = (a: QueueEntry, b: QueueEntry) => (a.since ?? "").localeCompare(b.since ?? "");
  freshnessDue.sort(bySince);
  expiringAssets.sort(bySince);
  return { draftOnMain, freshnessDue, missingSummary, missingCategory, noEnglish, expiringAssets, unregistered, metaErrors };
}
