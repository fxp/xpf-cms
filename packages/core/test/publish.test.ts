import { describe, it, expect } from "vitest";
import { loadConfig, planPublish, mergeRegistry, ownershipFor, isDerived, globToRegExp, MapView, OverlayView, parseRef, type Bundle, type BundleChange } from "../src/index.ts";

const config = loadConfig();
// landscape and live were retired from the site; the id-less tracked kind (`registered`) is still supported, so test it on a synthetic vertical
const configReg = { ...config, verticals: { ...config.verticals, live: { label: "Live", listing: ["live/index.html"], dirs: ["live"], url_prefix: "/live/", id_prefix: "LV", counter: null, registered: true } } } as typeof config;
const put = (path: string, content: string): BundleChange => ({ path, op: "put", encoding: "utf8", content, size: content.length });
const del = (path: string): BundleChange => ({ path, op: "delete" });
const json = (o: unknown) => JSON.stringify(o, null, 2) + "\n";

const meta = (slug: string, extra: Record<string, unknown> = {}) => json({
  slug, type: "howto", title: { zh: "标题" }, status: "published", visibility: "public",
  summary: "s", first_published: "2026-10-09", last_updated: "2026-10-09", current_version: 1, ...extra,
});
const registry = (over: Record<string, unknown> = {}) => ({
  _comment: "x",
  counters: { howto: 3, buzzwords: 106, predictions: 61, ...(over.counters as object) },
  items: [
    { id: "0003", type: "howto", slug: "wiki-skill", date: "2026-09-03", title: "WikiSkill" },
    { id: "0106", type: "buzzwords", ep: 106, date: "2026-10-09", title: "EP.106" },
    ...((over.items as object[]) ?? []),
  ],
});
const baseFiles = (): Record<string, string> => ({
  "config/content-index.json": json(registry()),
  "howto/index.html": '<li data-slug="wiki-skill"></li>',
  "howto/wiki-skill/index.html": "<html>ok</html>",
  "howto/wiki-skill/index.meta.json": meta("wiki-skill"),
  "buzzwords/data/index.json": json([{ ep: 106, web: "/buzzwords/106/" }]),
  "buzzwords/106/index.html": "<html>ep106</html>",
});
const base = () => new MapView(baseFiles());
const codes = (p: { findings: { code: string; severity: string }[] }, sev = "error") => p.findings.filter(f => f.severity === sev).map(f => f.code);

// a valid "add howto/new-guide" bundle, like a skill leaves it in the working tree
const addBundle = (): Bundle => ({
  changes: [
    put("howto/new-guide/index.html", "<html>guide</html>"),
    put("howto/new-guide/index.meta.json", meta("new-guide")),
    put("howto/index.html", '<li data-slug="wiki-skill"></li><li data-slug="new-guide"></li>'),
    put("config/content-index.json", json(registry({ counters: { howto: 4 }, items: [{ id: "0004", type: "howto", slug: "new-guide", date: "2026-10-09", title: "New" }] }))),
  ],
});

describe("globs and ownership", () => {
  it("matches ** across depth and * within a segment", () => {
    expect(globToRegExp("deepdive/c/**").test("deepdive/c/governance/index.html")).toBe(true);
    expect(globToRegExp("**/index.md").test("index.md")).toBe(true);
    expect(globToRegExp("**/index.md").test("a/b/index.md")).toBe(true);
    expect(globToRegExp("**/index.md").test("a/bindex.md")).toBe(false);
    expect(globToRegExp("llms.txt").test("deepdive/llms.txt")).toBe(false);
    expect(globToRegExp("a/*.json").test("a/x/y.json")).toBe(false);
  });
  it("owns the item dir, registry and listing — and not a sibling item", () => {
    const own = ownershipFor(config, "howto", "howto/new-guide");
    expect(own("howto/new-guide/media/a.png")).toBe(true);
    expect(own("config/content-index.json")).toBe(true);
    expect(own("howto/index.html")).toBe(true);
    expect(own("howto/wiki-skill/index.html")).toBe(false);
    expect(own("howto/new-guide-2/index.html")).toBe(false);
  });
  it("does not own the registry for types that are not tracked in it", () => {
    expect(ownershipFor(config, "training", "training/x")("config/content-index.json")).toBe(false);
  });
  it("owns the registry for id-less tracked types (`registered`)", () => {
    expect(ownershipFor(configReg, "live", "live/x")("config/content-index.json")).toBe(true);
  });
  it("labs.json is hand-edited data: not derived", () => {
    expect(isDerived(config, "deepdive/_data/labs.json")).toBe(false);
    expect(isDerived(config, "deepdive/_data/articles.json")).toBe(true);
  });
  it("treats site-level generated files as derived", () => {
    for (const p of ["config/site-manifest.json", "sitemap.xml", "deepdive/index.html", "deepdive/c/x/index.html", "deepdive/llms.txt"]) expect(isDerived(config, p)).toBe(true);
    expect(isDerived(config, "howto/new-guide/index.html")).toBe(false);
  });
  it("parses refs", () => {
    expect(parseRef("buzzwords/106")).toEqual({ type: "buzzwords", slug: "106" });
    expect(() => parseRef("nope")).toThrow();
  });
});

describe("OverlayView", () => {
  it("lays puts and deletes over the base", async () => {
    const v = new OverlayView(base(), { changes: [put("a.txt", "A"), del("howto/index.html")] });
    expect(await v.read("a.txt")).toBe("A");
    expect(await v.exists("howto/index.html")).toBe(false);
    expect(await v.exists("howto/wiki-skill/index.html")).toBe(true);
  });
});

describe("mergeRegistry", () => {
  it("takes only this ref's entry and counter from the working copy", () => {
    const b = registry();
    const w = registry({ counters: { howto: 5 }, items: [{ id: "0004", type: "howto", slug: "a" }, { id: "0005", type: "howto", slug: "b" }] });
    const { merged, foreignChanged } = mergeRegistry(b, w, "howto/a", "howto");
    expect(merged.items.map((e: any) => e.slug).filter(Boolean)).toContain("a");
    expect(merged.items.some((e: any) => e.slug === "b")).toBe(false);
    expect(merged.counters.howto).toBe(4);          // not 5: "b" stays local
    expect(foreignChanged).toBe(1);
  });
});

describe("planPublish · add", () => {
  it("accepts a clean add and writes a conventional commit", async () => {
    const plan = await planPublish(base(), addBundle(), { ref: "howto/new-guide", verb: "add", summary: "first guide", actor: "agent:claude-code", derive: true }, config);
    expect(codes(plan)).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.id).toBe("0004");
    expect(plan.commit.subject).toBe("feat(howto): add new-guide [HT·0004]");
    expect(plan.commit.message).toContain("first guide");
    expect(plan.commit.message).toContain("Published-via: xpf-cms");
    expect(plan.commit.message).toContain("Artifact: howto/new-guide");
    expect(plan.commit.message).toContain("Actor: agent:claude-code");
    expect(plan.commit.message).toContain("Derive: pending");
  });
  it("appends [content-update] only on request", async () => {
    const plan = await planPublish(base(), addBundle(), { ref: "howto/new-guide", verb: "add", calendar: true }, config);
    expect(plan.commit.subject.endsWith("[content-update]")).toBe(true);
  });
  it("rejects an add of something already registered", async () => {
    const plan = await planPublish(base(), { changes: [put("howto/wiki-skill/index.html", "<html>x</html>")] }, { ref: "howto/wiki-skill", verb: "add" }, config);
    expect(codes(plan)).toContain("already-published");
  });
  it("rejects a duplicate id", async () => {
    const b = addBundle();
    b.changes[3] = put("config/content-index.json", json(registry({ counters: { howto: 4 }, items: [{ id: "0003", type: "howto", slug: "new-guide" }] })));
    const plan = await planPublish(base(), b, { ref: "howto/new-guide", verb: "add" }, config);
    expect(codes(plan)).toContain("id-duplicate");
  });
  it("rejects an id that is not above the base counter (lost a race)", async () => {
    const b = addBundle();
    b.changes[3] = put("config/content-index.json", json(registry({ counters: { howto: 3 }, items: [{ id: "0002", type: "howto", slug: "new-guide" }] })));
    const plan = await planPublish(base(), b, { ref: "howto/new-guide", verb: "add" }, config);
    expect(codes(plan)).toContain("id-not-fresh");
  });
  it("requires a registry entry", async () => {
    const b = addBundle(); b.changes.pop();
    const plan = await planPublish(base(), b, { ref: "howto/new-guide", verb: "add" }, config);
    expect(codes(plan)).toContain("registry-entry-missing");
  });
  it("requires valid meta and a publishable state", async () => {
    const b = addBundle();
    b.changes[1] = put("howto/new-guide/index.meta.json", meta("new-guide", { status: "draft" }));
    expect(codes(await planPublish(base(), b, { ref: "howto/new-guide", verb: "add" }, config))).toContain("not-published-state");
    const ph = await planPublish(base(), b, { ref: "howto/new-guide", verb: "add", placeholder: true }, config);
    expect(codes(ph)).not.toContain("not-published-state");
    expect(codes(ph, "warning")).toContain("not-published-state");
    b.changes[1] = put("howto/new-guide/index.meta.json", "{not json");
    expect(codes(await planPublish(base(), b, { ref: "howto/new-guide", verb: "add" }, config))).toContain("meta-invalid");
    b.changes[1] = put("howto/new-guide/index.meta.json", meta("new-guide", { visibility: "private" }));
    expect(codes(await planPublish(base(), b, { ref: "howto/new-guide", verb: "add" }, config))).toContain("not-public");
  });
  it("bans the wrong author name", async () => {
    const b = addBundle(); b.changes[0] = put("howto/new-guide/index.html", "<p>作者：冯晓平</p>");
    expect(codes(await planPublish(base(), b, { ref: "howto/new-guide", verb: "add" }, config))).toContain("author-name");
  });
  it("warns when the listing does not mention the slug", async () => {
    const b = addBundle(); b.changes[2] = put("howto/index.html", '<li data-slug="wiki-skill"></li>');
    const plan = await planPublish(base(), b, { ref: "howto/new-guide", verb: "add" }, config);
    expect(codes(plan, "warning")).toContain("listing-missing-slug");
    expect(plan.ok).toBe(true);
  });
});

describe("planPublish · ownership", () => {
  it("rejects paths belonging to another item, and forbidden paths", async () => {
    const b = addBundle();
    b.changes.push(put("howto/wiki-skill/index.html", "<html>sneaky</html>"), put(".github/workflows/x.yml", "x"), put("scripts/y.py", "y"));
    const plan = await planPublish(base(), b, { ref: "howto/new-guide", verb: "add" }, config);
    expect(codes(plan)).toContain("unowned-path");
    expect(codes(plan)).toContain("forbidden-path");
    expect(plan.changes.some(c => c.path === "howto/wiki-skill/index.html")).toBe(false);
  });
  it("drops derived files silently and allows --also paths", async () => {
    const b = addBundle();
    b.changes.push(put("config/site-manifest.json", "{}"), put("sitemap.xml", "<x/>"), put("_redirects", "/a /b 301"));
    const plan = await planPublish(base(), b, { ref: "howto/new-guide", verb: "add", also: ["_redirects"] }, config);
    expect(plan.skippedDerived.sort()).toEqual(["config/site-manifest.json", "sitemap.xml"]);
    expect(plan.changes.some(c => c.path === "_redirects")).toBe(true);
    expect(plan.ok).toBe(true);
  });
  it("refuses a bundle with nothing to publish", async () => {
    const plan = await planPublish(base(), { changes: [] }, { ref: "howto/wiki-skill", verb: "update" }, config);
    expect(codes(plan)).toContain("no-changes");
  });
});

describe("planPublish · update", () => {
  it("accepts an edit and leaves the registry alone when it did not change", async () => {
    const plan = await planPublish(base(), { changes: [put("howto/wiki-skill/index.html", "<html>v2</html>"), put("config/content-index.json", json(registry()))] }, { ref: "howto/wiki-skill", verb: "update" }, config);
    expect(plan.ok).toBe(true);
    expect(plan.commit.subject).toBe("fix(howto): update wiki-skill [HT·0003]");
    expect(plan.changes.map(c => c.path)).toEqual(["howto/wiki-skill/index.html"]);
  });
  it("warns when the version was not bumped, and refuses updates to unknown items", async () => {
    const edit = put("howto/wiki-skill/index.meta.json", meta("wiki-skill", { summary: "changed" }));
    expect(codes(await planPublish(base(), { changes: [edit] }, { ref: "howto/wiki-skill", verb: "update" }, config), "warning")).toContain("version-not-bumped");
    const ghost = await planPublish(base(), { changes: [put("howto/ghost/index.html", "<html/>"), put("howto/ghost/index.meta.json", meta("ghost"))] }, { ref: "howto/ghost", verb: "update" }, config);
    expect(codes(ghost)).toContain("not-published");
  });
});

describe("planPublish · remove", () => {
  it("requires the registry tombstone", async () => {
    const plain = await planPublish(base(), { changes: [del("howto/wiki-skill/index.html")] }, { ref: "howto/wiki-skill", verb: "remove" }, config);
    expect(codes(plain)).toContain("remove-not-marked");
    const tomb = registry(); (tomb.items[0] as any).status = "removed"; (tomb.items[0] as any).removed_date = "2026-10-09";
    const ok = await planPublish(base(), { changes: [put("config/content-index.json", json(tomb)), put("howto/index.html", "<ul></ul>"), del("howto/wiki-skill/index.html"), del("howto/wiki-skill/index.meta.json")] }, { ref: "howto/wiki-skill", verb: "remove" }, config);
    expect(codes(ok)).toEqual([]);
    expect(ok.commit.subject).toBe("chore(howto): remove wiki-skill [HT·0003]");
  });
});

describe("planPublish · buzzwords", () => {
  it("accepts an edit of an episode without per-item meta", async () => {
    const plan = await planPublish(base(), { changes: [put("buzzwords/106/index.html", "<html>ep106 v2</html>")] }, { ref: "buzzwords/106", verb: "update" }, config);
    expect(plan.ok).toBe(true);
    expect(plan.commit.subject).toBe("fix(buzzwords): update EP.106 [EP·0106]");
  });
  it("requires the episode to be in the aggregate index for an add", async () => {
    const b: Bundle = { changes: [
      put("buzzwords/107/index.html", "<html>107</html>"),
      put("config/content-index.json", json(registry({ counters: { buzzwords: 107 }, items: [{ id: "0107", type: "buzzwords", ep: 107, date: "2026-10-16", title: "EP.107" }] }))),
      put("buzzwords/data/index.json", json([{ ep: 106, web: "/buzzwords/106/" }])),
    ] };
    const plan = await planPublish(base(), b, { ref: "buzzwords/107", verb: "add" }, config);
    expect(codes(plan)).toContain("listing-missing-item");
    b.changes[2] = put("buzzwords/data/index.json", json([{ ep: 106 }, { ep: 107, web: "/buzzwords/107/" }]));
    const ok = await planPublish(base(), b, { ref: "buzzwords/107", verb: "add" }, config);
    expect(codes(ok)).toEqual([]);
    expect(ok.commit.subject).toBe("feat(buzzwords): publish EP.107 [EP·0107]");
  });
});

describe("planPublish · guards", () => {
  it("rejects unknown and federated verticals", async () => {
    expect(codes(await planPublish(base(), { changes: [] }, { ref: "nope/x", verb: "add" }, config))).toContain("unknown-type");
    const orphan = { ...config, verticals: { ...config.verticals, ext: { label: "Ext", dirs: [], url_prefix: "https://ext.example/", id_prefix: "EX", counter: null, federated: true } } } as typeof config;
    expect(codes(await planPublish(base(), { changes: [] }, { ref: "ext/x", verb: "add" }, orphan))).toContain("federated-type");     // federated and nothing registered here: nothing to publish
  });
});

describe("planPublish · id-less tracked verticals (`registered`)", () => {
  const withLive = (extra: object[] = []) => json(registry({ items: [{ type: "live", slug: "old-page", date: "2026-09-01", title: "Old", ...{} }, ...extra] }));
  const liveBase = () => new MapView({
    ...baseFiles(),
    "config/content-index.json": withLive(),
    "live/index.html": '<li data-slug="old-page"></li>',
    "live/old-page/index.html": "<html>old</html>",
    "live/old-page/index.meta.json": meta("old-page", { type: "live" }),
  });
  const newPage = (entry?: object): Bundle => ({
    changes: [
      put("live/new-page/index.html", "<html>new</html>"),
      put("live/new-page/index.meta.json", meta("new-page", { type: "live" })),
      put("live/index.html", '<li data-slug="old-page"></li><li data-slug="new-page"></li>'),
      ...(entry ? [put("config/content-index.json", withLive([entry]))] : []),
    ],
  });
  const entry = { type: "live", slug: "new-page", date: "2026-10-29", title: "New" };

  it("add needs the registry entry now, like every tracked type", async () => {
    const p = await planPublish(liveBase(), newPage(), { ref: "live/new-page", verb: "add" }, configReg);
    expect(codes(p)).toContain("registry-entry-missing");
  });
  it("accepts an add with an id-less entry and sends the registry with just that row added", async () => {
    const p = await planPublish(liveBase(), newPage(entry), { ref: "live/new-page", verb: "add" }, configReg);
    expect(codes(p)).toEqual([]);
    expect(p.id).toBeNull();
    const reg = p.changes.find(c => c.path === "config/content-index.json")!;
    expect(JSON.parse(reg.content!).items.filter((e: any) => e.type === "live").map((e: any) => e.slug)).toEqual(["old-page", "new-page"]);
    expect(p.commit.subject).toBe("feat(live): add new-page");
  });
  it("keeps rows other publishes added since the bundle was written (semantic merge, not overwrite)", async () => {
    const racing = new MapView({ ...baseFiles(), "config/content-index.json": withLive([{ type: "live", slug: "raced", date: "2026-10-28", title: "Raced" }]), "live/index.html": "", "live/old-page/index.html": "x", "live/old-page/index.meta.json": meta("old-page", { type: "live" }) });
    const p = await planPublish(racing, newPage(entry), { ref: "live/new-page", verb: "add" }, configReg);
    expect(codes(p)).toEqual([]);
    const reg = JSON.parse(p.changes.find(c => c.path === "config/content-index.json")!.content!);
    expect(reg.items.filter((e: any) => e.type === "live").map((e: any) => e.slug).sort()).toEqual(["new-page", "old-page", "raced"]);
  });
  it("updates a page that was never registered with a warning, not an error, and never sends a stray registry", async () => {
    const files = { ...baseFiles(), "live/index.html": "", "live/legacy/index.html": "<html>legacy</html>", "live/legacy/index.meta.json": meta("legacy", { type: "live" }) };
    const bundle: Bundle = { changes: [put("live/legacy/index.html", "<html>legacy v2</html>"), put("config/content-index.json", json({ counters: {}, items: [] }))] };
    const p = await planPublish(new MapView(files), bundle, { ref: "live/legacy", verb: "update" }, configReg);
    expect(codes(p)).toEqual([]);
    expect(codes(p, "warning")).toEqual(expect.arrayContaining(["not-registered", "registry-ignored"]));
    expect(p.changes.map(c => c.path)).toEqual(["live/legacy/index.html"]);
  });
  it("remove still requires the tombstone", async () => {
    const files = { ...baseFiles(), "config/content-index.json": withLive(), "live/old-page/index.html": "x", "live/old-page/index.meta.json": meta("old-page", { type: "live" }) };
    const unmarked: Bundle = { changes: [del("live/old-page/index.html"), del("live/old-page/index.meta.json")] };
    expect(codes(await planPublish(new MapView(files), unmarked, { ref: "live/old-page", verb: "remove" }, configReg))).toContain("remove-not-marked");
  });
});

describe("planPublish · tree (graph/, generated as one unit)", () => {
  const baseTree = () => new MapView({ ...baseFiles(), "graph/index.html": "<html>old</html>", "graph/e/org/openai/index.html": "<html>openai</html>", "graph/gone/index.html": "x" });
  const update = (changes: BundleChange[], extra: object = {}) => planPublish(baseTree(), { changes }, { ref: "graph/site", verb: "update", ...extra }, config);

  it("accepts a refresh of the tree: any file under graph/, deletions included, no item meta / registry / listing needed", async () => {
    const p = await update([put("graph/index.html", "<html>new</html>"), put("graph/e/org/new/index.html", "<html>new org</html>"), del("graph/gone/index.html")]);
    expect(codes(p)).toEqual([]);
    expect(p.itemDir).toBe("graph");
    expect(p.id).toBeNull();
    expect(p.changes.map(c => `${c.op}:${c.path}`).sort()).toEqual(["delete:graph/gone/index.html", "put:graph/e/org/new/index.html", "put:graph/index.html"]);
    expect(p.commit.subject).toBe("chore(graph): refresh site");
    expect(p.commit.message).toContain("Artifact: graph/site");
  });
  it("is update-only: add and remove make no sense for a tree", async () => {
    for (const verb of ["add", "remove"] as const) {
      const p = await planPublish(baseTree(), { changes: [put("graph/index.html", "x")] }, { ref: "graph/site", verb }, config);
      expect(codes(p)).toContain("tree-update-only");
    }
  });
  it("code and config never travel: functions/, scripts/, _headers are forbidden even next to graph pages", async () => {
    const p = await update([put("graph/index.html", "x"), put("functions/api/graph/query.js", "x"), put("scripts/build_sitemap.py", "x"), put("_headers", "x")]);
    expect(codes(p).filter(c => c === "forbidden-path")).toHaveLength(3);
    expect(p.ok).toBe(false);
  });
  it("a file outside graph/ needs --also (e.g. _redirects); generated root files are dropped, not errors", async () => {
    const files = [put("graph/index.html", "x"), put("_redirects", "/live/* /graph/:splat 301"), put("sitemap.xml", "<urlset/>")];
    const without = await update(files);
    expect(codes(without)).toEqual(["unowned-path"]);
    const withAlso = await update(files, { also: ["_redirects"] });
    expect(codes(withAlso)).toEqual([]);
    expect(withAlso.changes.map(c => c.path).sort()).toEqual(["_redirects", "graph/index.html"]);
    expect(withAlso.skippedDerived).toEqual(["sitemap.xml"]);
  });
  it("refuses an empty refresh and warns about mass deletion", async () => {
    expect(codes(await update([]))).toContain("no-changes");
    const many = Array.from({ length: 201 }, (_, i) => del(`graph/e/org/x${i}/index.html`));
    expect(codes(await update([put("graph/index.html", "x"), ...many]), "warning")).toContain("tree-many-deletes");
  });
  it("owns exactly the tree's directories (not a sibling with the same prefix)", () => {
    const own = ownershipFor(config, "graph", "graph");
    expect(own("graph/e/org/openai/index.html")).toBe(true);
    expect(own("graph2/index.html")).toBe(false);
    expect(own("config/content-index.json")).toBe(false);
  });
});

describe("planPublish · federated (roam: only the registry row is published here)", () => {
  const roamFiles = () => ({ ...baseFiles(), "config/content-index.json": json(registry({ counters: { roam: 11 }, items: [{ id: "0011", type: "roam", slug: "native-agent-focus-room", date: "2026-10-26", title: "x" }] })) });
  const roamBase = () => new MapView(roamFiles());
  const withRow = (extra: object[] = [], counter = 12) => json(registry({ counters: { roam: counter }, items: [{ id: "0011", type: "roam", slug: "native-agent-focus-room", date: "2026-10-26", title: "x" }, ...extra] }));
  const newRow = { id: "0012", type: "roam", slug: "hardware-agent-bench", date: "2026-11-11", title: "硬件 Agent 接入 Bench" };
  const add = (changes: BundleChange[], over: object = {}) => planPublish(roamBase(), { changes }, { ref: "roam/hardware-agent-bench", verb: "add", ...over }, config);

  it("accepts an add that carries nothing but the registry row, with a conventional commit and the RM tag", async () => {
    const p = await add([put("config/content-index.json", withRow([newRow]))]);
    expect(codes(p)).toEqual([]);
    expect(p.id).toBe("0012");
    expect(p.itemDir).toBeNull();
    expect(p.changes.map(c => c.path)).toEqual(["config/content-index.json"]);
    expect(p.commit.subject).toBe("feat(roam): add hardware-agent-bench [RM·0012]");
    expect(JSON.parse(p.changes[0].content!).counters.roam).toBe(12);
  });
  it("needs the registry row, and refuses a stale id", async () => {
    expect(codes(await add([put("config/content-index.json", withRow())]))).toContain("registry-entry-missing");
    const stale = await add([put("config/content-index.json", withRow([{ ...newRow, id: "0011" }], 11))]);
    expect(codes(stale)).toEqual(expect.arrayContaining(["id-duplicate"]));
  });
  it("refuses anything but the registry: pages live in their own repo (no item dir, listing, or --also needed)", async () => {
    const p = await add([put("config/content-index.json", withRow([newRow])), put("roam/hardware-agent-bench/index.html", "<html>")]);
    expect(codes(p)).toContain("unowned-path");
    expect(p.ok).toBe(false);
  });
  it("remove writes the tombstone; an unregistered task cannot be removed", async () => {
    const tomb = json(registry({ counters: { roam: 11 }, items: [{ id: "0011", type: "roam", slug: "native-agent-focus-room", date: "2026-10-26", title: "x", status: "removed", removed_date: "2026-11-12" }] }));
    const ok = await planPublish(roamBase(), { changes: [put("config/content-index.json", tomb)] }, { ref: "roam/native-agent-focus-room", verb: "remove" }, config);
    expect(codes(ok)).toEqual([]);
    expect(ok.commit.subject).toBe("chore(roam): remove native-agent-focus-room [RM·0011]");
    const none = await planPublish(roamBase(), { changes: [put("config/content-index.json", tomb)] }, { ref: "roam/never-registered", verb: "remove" }, config);
    expect(codes(none)).toContain("not-published");
  });
  it("an update that changes nothing in the registry is rejected as empty (no empty commits)", async () => {
    const p = await planPublish(roamBase(), { changes: [put("config/content-index.json", withRow())] }, { ref: "roam/native-agent-focus-room", verb: "update" }, config);
    expect(codes(p)).toContain("no-changes");
  });
});

describe("planPublish · labs (two hand-edited files published as one unit)", () => {
  const labsBase = () => new MapView({ ...baseFiles(), "deepdive/_data/labs.json": "{}", "deepdive/lab-watch/index.html": "<html>old</html>", "deepdive/lab-watch/frontier-startups.html": "<html>zh</html>", "deepdive/_data/articles.json": "[]" });
  const upd = (changes: BundleChange[], over: object = {}) => planPublish(labsBase(), { changes }, { ref: "labs/lab-watch", verb: "update", ...over }, config);

  it("accepts the two files together, with no meta, registry or listing", async () => {
    const p = await upd([put("deepdive/_data/labs.json", '{"DATA":[1]}'), put("deepdive/lab-watch/index.html", "<html>new</html>")]);
    expect(codes(p)).toEqual([]);
    expect(p.itemDir).toBeNull();
    expect(p.id).toBeNull();
    expect(p.changes.map(c => c.path).sort()).toEqual(["deepdive/_data/labs.json", "deepdive/lab-watch/index.html"]);
    expect(p.commit.subject).toBe("chore(labs): refresh lab-watch");
  });
  it("owns exactly those two files: neither the other lab-watch pages nor the rest of _data", async () => {
    const own = ownershipFor(config, "labs", "");
    expect(own("deepdive/_data/labs.json")).toBe(true);
    expect(own("deepdive/lab-watch/index.html")).toBe(true);
    expect(own("deepdive/lab-watch/frontier-startups.html")).toBe(false);
    expect(own("deepdive/_data/articles.json")).toBe(false);
    expect(own("config/content-index.json")).toBe(false);
  });
  it("refuses another lab-watch page riding along (that is a DeepDive article), and an empty refresh", async () => {
    expect(codes(await upd([put("deepdive/_data/labs.json", "{}"), put("deepdive/lab-watch/frontier-startups.html", "x")]))).toContain("unowned-path");
    expect(codes(await upd([]))).toContain("no-changes");
  });
  it("the generated lab table and data files are not part of it: derived paths are dropped, not errors", async () => {
    const p = await upd([put("deepdive/_data/labs.json", "{}"), put("deepdive/_data/articles.json", "[1]")]);
    expect(codes(p)).toEqual([]);
    expect(p.skippedDerived).toEqual(["deepdive/_data/articles.json"]);
  });
});

