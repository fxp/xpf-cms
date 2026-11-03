// The graph (xiaopingfeng.com/graph/) is published as one tree, so its pages are not in the site manifest. Its analysis pages are
// nodes in the entity library and the library's own read API lists them; the CMS index mirrors that list so the dashboard shows them.
export interface GraphPageRow { ref: string; type: "graph"; slug: string; title: string; state: "published"; url_path: string; date: string | null }

export function graphPageRows(api: any): GraphPageRow[] {
  const nodes: any[] = Array.isArray(api?.nodes) ? api.nodes : [];
  const generated: string | null = typeof api?.generated === "string" ? api.generated : null;
  const rows: GraphPageRow[] = [];
  for (const n of nodes) {
    if (n?.type !== "Page" || typeof n.path !== "string" || !n.path) continue;
    const path = n.path === "index" ? "" : n.path.replace(/^\/+|\/+$/g, "");
    rows.push({ ref: `graph/${n.path}`, type: "graph", slug: String(n.path), title: String(n.name ?? n.path), state: "published", url_path: path ? `/graph/${path}/` : "/graph/", date: generated });
  }
  return rows.sort((a, b) => a.ref.localeCompare(b.ref));
}

export async function fetchGraphPages(siteBase: string, fetchImpl: typeof fetch = (i, init) => fetch(i, init)): Promise<GraphPageRow[] | null> {
  try {
    const r = await fetchImpl(`${siteBase}/api/graph/query?type=page&limit=1000&format=json`, { headers: { "user-agent": "xpf-cms-reindex" } });
    if (!r.ok) return null;
    return graphPageRows(await r.json());
  } catch { return null; }
}
