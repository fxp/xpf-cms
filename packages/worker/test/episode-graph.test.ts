import { describe, expect, it } from "vitest";
import type { PublishPlan } from "@xpf/core/edge";
import { episodeGraphForPublish, verifyEpisodeGraph } from "../src/episode-graph.ts";

const episode: PublishPlan = {
  ok: true, ref: "buzzwords/112", type: "buzzwords", slug: "112", verb: "update", itemDir: "buzzwords/112", id: "0112",
  findings: [], skippedDerived: [], changes: [{ path: "buzzwords/112/index.html", op: "put" }],
  commit: { subject: "", body: "", message: "" },
};

describe("episodeGraphForPublish", () => {
  it("tracks new production episodes and production updates of the episode page", () => {
    expect(episodeGraphForPublish(episode, true)).toBe("112");
    expect(episodeGraphForPublish({ ...episode, verb: "add" }, true)).toBe("112");
  });

  it("excludes sandbox runs, removals, asset-only updates and independent Graph releases", () => {
    expect(episodeGraphForPublish(episode, false)).toBeUndefined();
    expect(episodeGraphForPublish({ ...episode, verb: "remove" }, true)).toBeUndefined();
    expect(episodeGraphForPublish({ ...episode, changes: [{ path: "buzzwords/112/cover.jpg", op: "put" }] }, true)).toBeUndefined();
    expect(episodeGraphForPublish({ ...episode, ref: "graph/site" }, true)).toBeUndefined();
  });

  it("lets presentation-only updates skip Graph while keeping the first release required", () => {
    expect(episodeGraphForPublish(episode, true, true)).toBeUndefined();
    expect(episodeGraphForPublish({ ...episode, verb: "add" }, true, true)).toBe("112");
  });
});

function publicGraph(node: object, options: { page?: string; total?: number; mentions?: object } = {}): typeof fetch {
  return (async (input) => {
    const url = new URL(String(input));
    switch (url.pathname) {
      case "/graph/e/ep/112/": return new Response(options.page ?? '<link rel="canonical" href="https://xiaopingfeng.com/graph/e/ep/112/"><a href="/buzzwords/112/">EP.112</a>');
      case "/api/graph/entity/ep:112": return Response.json({ node });
      case "/api/graph/query":
        expect(url.searchParams.get("where")).toBe("in_eps=112");
        return Response.json({ total: options.total ?? 9 });
      case "/graph/data/episode-mentions.json": return Response.json(options.mentions ?? { by_entity: { "org:openai": { 112: 4 } } });
      default: return new Response("missing", { status: 404 });
    }
  }) as typeof fetch;
}

const BASE = "https://xiaopingfeng.com";
const GRAPH_REVISION = "abc01235";
const imported = { id: "ep:112", page: "/buzzwords/112/", n_stories: 14, n_items: 52, n_models: 9, n_in_window: 8, n_entities: 60 };

describe("verifyEpisodeGraph", () => {
  it("accepts a populated episode with a matching model query and readable mention index", async () => {
    await expect(verifyEpisodeGraph(BASE, "112", GRAPH_REVISION, publicGraph(imported))).resolves.toBeUndefined();
  });

  it("rejects a model ledger stub without content and a fallback page that returns 200", async () => {
    const stub = { id: "ep:112", page: "/buzzwords/112/", n_models: 9 };
    await expect(verifyEpisodeGraph(BASE, "112", GRAPH_REVISION, publicGraph(stub))).rejects.toThrow("no imported episode content");
    await expect(verifyEpisodeGraph(BASE, "112", GRAPH_REVISION, publicGraph(imported, { page: '<title>Home</title><a href="/buzzwords/112/">EP.112</a>' }))).rejects.toThrow("entity page");
  });

  it("rejects mismatched model data or a missing mentions index", async () => {
    await expect(verifyEpisodeGraph(BASE, "112", GRAPH_REVISION, publicGraph(imported, { total: 0 }))).rejects.toThrow("model query differs");
    await expect(verifyEpisodeGraph(BASE, "112", GRAPH_REVISION, publicGraph(imported, { mentions: {} }))).rejects.toThrow("mentions index");
    await expect(verifyEpisodeGraph(BASE, "112", GRAPH_REVISION, publicGraph(imported, { mentions: { by_entity: {} } }))).rejects.toThrow("no record");
  });
});
