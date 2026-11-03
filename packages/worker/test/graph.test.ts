import { describe, it, expect } from "vitest";
import { graphPageRows, fetchGraphPages } from "../src/graph.ts";

const api = { generated: "2026-11-03", nodes: [
  { id: "page:index", type: "Page", name: "关系图谱", path: "index", page: "/graph/" },
  { id: "page:neolab/archive", type: "Page", name: "NEO LAB 档案", path: "neolab/archive", page: "/graph/neolab/archive/" },
  { id: "org:openai", type: "Organization", name: "OpenAI" },                 // not a page
  { id: "page:", type: "Page", name: "no path" },                              // malformed
] };

describe("graph pages for the CMS index", () => {
  it("turns the library's Page nodes into index rows: home is /graph/, nested paths keep their slashes", () => {
    expect(graphPageRows(api)).toEqual([
      { ref: "graph/index", type: "graph", slug: "index", title: "关系图谱", state: "published", url_path: "/graph/", date: "2026-11-03" },
      { ref: "graph/neolab/archive", type: "graph", slug: "neolab/archive", title: "NEO LAB 档案", state: "published", url_path: "/graph/neolab/archive/", date: "2026-11-03" },
    ]);
  });
  it("tolerates garbage", () => { expect(graphPageRows(null)).toEqual([]); expect(graphPageRows({ nodes: "x" })).toEqual([]); });
  it("fetch: rows on success, null on a failing or unreachable API (so a reindex keeps the old rows)", async () => {
    const ok = (async () => new Response(JSON.stringify(api), { status: 200 })) as typeof fetch;
    expect((await fetchGraphPages("https://x", ok))!.length).toBe(2);
    expect(await fetchGraphPages("https://x", (async () => new Response("no", { status: 500 })) as typeof fetch)).toBeNull();
    expect(await fetchGraphPages("https://x", (async () => { throw new Error("down"); }) as typeof fetch)).toBeNull();
  });
});
