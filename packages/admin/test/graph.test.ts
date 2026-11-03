import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGraphSummary } from "../src/graph.ts";
import { renderGraph } from "../src/render.ts";

const site = (kb?: unknown) => {
  const root = mkdtempSync(path.join(tmpdir(), "xpf-graph-"));
  if (kb !== undefined) { mkdirSync(path.join(root, "graph/data"), { recursive: true }); writeFileSync(path.join(root, "graph/data/kb.json"), typeof kb === "string" ? kb : JSON.stringify(kb)); }
  return root;
};
const kb = {
  generated: "2026-11-03",
  analytics: { nodes: 1650, edges: 2933, edges_core: 1116, node_types: { Organization: 630, Model: 203, Page: 10 }, edge_types: { developed_by: 400 }, provisional_orgs: 5, agent: { links: 674, links_unreviewed: 12, note: "x" } },
  nodes: [
    { id: "page:models", type: "Page", name: "AI 新模型台账", path: "models", page: "/graph/models/", group: "Landscape", order: 20, n_blocks: 8 },
    { id: "page:index", type: "Page", name: "关系图谱", path: "index", page: "/graph/", group: "总览", order: 0, n_blocks: 9 },
    { id: "org:openai", type: "Organization", name: "OpenAI" },
  ],
};

describe("loadGraphSummary", () => {
  it("summarizes the library build the site carries", () => {
    const s = loadGraphSummary(site(kb))!;
    expect(s).toMatchObject({ generated: "2026-11-03", nodes: 1650, edges: 2933, coreEdges: 1116, provisionalOrgs: 5 });
    expect(s.nodeTypes[0]).toEqual(["Organization", 630]);
    expect(s.pages.map(p => p.path)).toEqual(["index", "models"]);                // by the library's own page order
    expect(s.pages[0]).toMatchObject({ name: "关系图谱", url: "/graph/", blocks: 9 });
    expect(s.agent).toEqual([["links", 674], ["links_unreviewed", 12]]);           // only numeric counters
  });
  it("returns null when the site has no graph build or it is unreadable", () => {
    expect(loadGraphSummary(site())).toBeNull();
    expect(loadGraphSummary(site("{not json"))).toBeNull();
  });
});

describe("renderGraph", () => {
  it("shows counts, the analysis pages as links, and flags provisional organizations", () => {
    const html = renderGraph(loadGraphSummary(site(kb)), "https://xiaopingfeng.com");
    expect(html).toContain("库建于 2026-11-03");
    expect(html).toContain('href="https://xiaopingfeng.com/graph/models/"');
    expect(html).toContain("AI 新模型台账");
    expect(html).toContain("1650");
    expect(html).toMatch(/class="card warn"><div class="n">5</);
    expect(html).toContain("links_unreviewed 12");
  });
  it("says so when the site has no graph build", () => {
    expect(renderGraph(null, "https://xiaopingfeng.com")).toContain("没有 graph/data/kb.json");
  });
  it("escapes page names", () => {
    const s = loadGraphSummary(site({ ...kb, nodes: [{ type: "Page", name: "<b>x</b>", path: "x", page: "/graph/x/", order: 1 }] }))!;
    expect(renderGraph(s, "https://x")).not.toContain("<b>x</b>");
  });
});
