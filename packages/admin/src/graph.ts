import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface GraphPage { path: string; name: string; url: string; group: string; blocks: number; order: number }
export interface GraphSummary {
  generated: string;
  nodes: number; edges: number; coreEdges: number;
  nodeTypes: [string, number][];
  edgeTypes: [string, number][];
  pages: GraphPage[];
  /** counters the library keeps about itself; the ones that need a human are provisional organizations and agent-added items awaiting review */
  provisionalOrgs: number;
  agent: [string, number][];
}

/** What the dashboard shows about the graph (xiaopingfeng.com/graph/): read from the library build the site already carries, so CI needs no network. */
export function loadGraphSummary(siteRoot: string): GraphSummary | null {
  const file = path.join(siteRoot, "graph", "data", "kb.json");
  if (!existsSync(file)) return null;
  let kb: any;
  try { kb = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  const a = kb.analytics ?? {};
  const counts = (o: any): [string, number][] => Object.entries(o ?? {}).filter(([, v]) => typeof v === "number").sort((x, y) => (y[1] as number) - (x[1] as number)) as [string, number][];
  const pages: GraphPage[] = (kb.nodes ?? []).filter((n: any) => n?.type === "Page").map((n: any) => ({
    path: String(n.path ?? n.slug ?? ""), name: String(n.name ?? n.path ?? ""), url: String(n.page ?? `/graph/${n.path}/`), group: String(n.group ?? ""), blocks: Number(n.n_blocks ?? 0), order: Number(n.order ?? 0),
  })).sort((x: GraphPage, y: GraphPage) => x.order - y.order || x.path.localeCompare(y.path));
  return {
    generated: String(kb.generated ?? a.generated ?? ""),
    nodes: Number(a.nodes ?? kb.nodes?.length ?? 0), edges: Number(a.edges ?? kb.edges?.length ?? 0), coreEdges: Number(a.edges_core ?? 0),
    nodeTypes: counts(a.node_types), edgeTypes: counts(a.edge_types),
    pages, provisionalOrgs: Number(a.provisional_orgs ?? 0), agent: counts(a.agent),
  };
}
