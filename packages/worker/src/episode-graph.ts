import type { PublishPlan } from "@xpf/core/edge";

export const AWAITING_GRAPH = "awaiting_graph";

export function episodeNumber(ref: string): string | undefined {
  return /^buzzwords\/([1-9]\d*)$/.exec(ref)?.[1];
}

export function episodeGraphForPublish(plan: PublishPlan, production: boolean, skipUpdate = false): string | undefined {
  const ep = episodeNumber(plan.ref);
  if (!production || !ep || plan.verb === "remove") return undefined;
  const page = `${plan.itemDir ?? plan.ref}/index.html`;
  return plan.verb === "add" || (!skipUpdate && plan.changes.some(c => c.op === "put" && c.path === page)) ? ep : undefined;
}

/** Check public data as well as the entity page, since unknown site paths can serve the homepage. */
export async function verifyEpisodeGraph(
  siteBase: string, ep: string, graphSha: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<void> {
  const get = async (path: string) => {
    const url = new URL(path, siteBase);
    url.searchParams.set("xpf", graphSha.slice(0, 8));
    const response = await fetchImpl(url, { headers: { "user-agent": "xpf-cms-verify" } });
    if (!response.ok) throw new Error(`${url.pathname} → ${response.status}`);
    return response;
  };
  const episodePath = `/buzzwords/${ep}/`;
  const graphPath = `/graph/e/ep/${ep}/`;
  const [page, entity, models, mentions] = await Promise.all([
    get(graphPath).then(r => r.text()),
    get(`/api/graph/entity/ep:${ep}`).then(r => r.json<{ node?: { id?: string; page?: string; n_stories?: number; n_items?: number; n_models?: number; n_entities?: number } }>()),
    get(`/api/graph/query?type=model&where=in_eps%3D${ep}&format=json`).then(r => r.json<{ total?: number }>()),
    get("/graph/data/episode-mentions.json").then(r => r.json<{ by_entity?: Record<string, Record<string, number>> }>()),
  ]);
  if (!page.includes(`rel="canonical" href="${new URL(graphPath, siteBase).href}"`)) {
    throw new Error(`Graph entity page for EP.${ep} is unavailable`);
  }
  if (!page.includes(`href="${episodePath}`) && !page.includes(`href="${new URL(episodePath, siteBase).href}`)) {
    throw new Error(`Graph entity page for EP.${ep} has no link back to the episode`);
  }
  const node = entity.node;
  if (node?.id !== `ep:${ep}` || node.page !== episodePath || !((node.n_stories ?? 0) + (node.n_items ?? 0) > 0)) {
    throw new Error(`Graph has no imported episode content for EP.${ep}`);
  }
  if (!Number.isSafeInteger(node.n_models) || models.total !== node.n_models) {
    throw new Error(`Graph model query differs from the EP.${ep} entity`);
  }
  if (!mentions.by_entity || Array.isArray(mentions.by_entity) || typeof mentions.by_entity !== "object") {
    throw new Error("Graph episode mentions index is unavailable");
  }
  if ((node.n_entities ?? 0) > 0 && !Object.values(mentions.by_entity).some(episodes => (episodes?.[ep] ?? 0) > 0)) {
    throw new Error(`Graph episode mentions index has no record for EP.${ep}`);
  }
}
