import { describe, it, expect } from "vitest";
import { loadConfig, planPublish, mergeRegistry, ownershipFor, isDerived, globToRegExp, MapView, OverlayView, parseRef, type Bundle, type BundleChange } from "../src/index.ts";

const config = loadConfig();
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
  it("does not own the registry for types without a counter", () => {
    expect(ownershipFor(config, "landscape", "landscape/x")("config/content-index.json")).toBe(false);
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
    expect(codes(await planPublish(base(), { changes: [] }, { ref: "roam/x", verb: "add" }, config))).toContain("federated-type");
  });
});
