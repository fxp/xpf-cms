import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { XpfConfig, BundleChange } from "@xpf/core/edge";
import { publish, HttpError, type ServiceDeps, type PublishRequest } from "../src/service.ts";
import { RefMovedError, type GithubLike, type TreeEntry } from "../src/github.ts";
import { signCommit } from "../src/sign.ts";

const config = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../config/verticals.json"), "utf8")) as XpfConfig;
const json = (o: unknown) => JSON.stringify(o, null, 2) + "\n";
const put = (p: string, content: string): BundleChange => ({ path: p, op: "put", encoding: "utf8", content, size: content.length });

const meta = (slug: string) => json({ slug, type: "howto", title: { zh: "标题" }, status: "published", visibility: "public", summary: "s", first_published: "2026-10-09", last_updated: "2026-10-09", current_version: 1 });
const registry = (counter: number, extra: object[] = []) => ({
  counters: { howto: counter }, items: [{ id: "0003", type: "howto", slug: "wiki-skill" }, ...extra],
});

/** Minimal in-memory git: commits → trees (path → content), enough for the Git Data API calls we make. */
class FakeGithub implements GithubLike {
  refs = new Map<string, string>();
  commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  trees = new Map<string, Record<string, string>>();
  blobs: string[] = [];
  n = 0;
  hookBeforeUpdateRef: (() => void) | null = null;
  constructor(files: Record<string, string>) {
    const t = this.newTree(files); const c = this.newCommit(t, [], "init"); this.refs.set("main", c);
  }
  private newTree(files: Record<string, string>) { const id = `t${++this.n}`; this.trees.set(id, files); return id; }
  private newCommit(tree: string, parents: string[], message: string) { const id = `c${++this.n}`; this.commits.set(id, { tree, parents, message }); return id; }
  files(branch: string) { return this.trees.get(this.commits.get(this.refs.get(branch)!)!.tree)!; }
  /** simulate someone else landing a commit on `branch` */
  land(branch: string, change: Record<string, string>) {
    const head = this.refs.get(branch)!;
    const tree = this.newTree({ ...this.files(branch), ...change });
    this.refs.set(branch, this.newCommit(tree, [head], "other"));
  }
  async getRef(b: string) { const sha = this.refs.get(b); return sha ? { sha } : null; }
  async createRef(b: string, sha: string) { this.refs.set(b, sha); }
  async getCommit(sha: string) { return { sha, tree: this.commits.get(sha)!.tree }; }
  async createBlob(b64: string) { this.blobs.push(b64); return `blob${this.blobs.length}`; }
  async createTree(base: string, entries: TreeEntry[]) {
    const f = { ...this.trees.get(base)! };
    for (const e of entries) {
      if (e.sha === null) delete f[e.path];
      else if (e.content !== undefined) f[e.path] = e.content;
      else f[e.path] = `<blob:${e.sha}>`;
    }
    return this.newTree(f);
  }
  async createCommit(i: { message: string; tree: string; parents: string[] }) { return this.newCommit(i.tree, i.parents, i.message); }
  async updateRef(b: string, sha: string) {
    this.hookBeforeUpdateRef?.(); this.hookBeforeUpdateRef = null;
    if (this.commits.get(sha)!.parents[0] !== this.refs.get(b)) throw new RefMovedError(b);
    this.refs.set(b, sha);
  }
  async compareFiles(base: string, head: string) {
    const a = this.trees.get(this.commits.get(base)!.tree)!, b = this.trees.get(this.commits.get(head)!.tree)!;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]);
  }
  async getText(p: string, ref: string) { const v = this.trees.get(this.commits.get(ref)!.tree)![p]; return v === undefined || v.startsWith("<blob:") ? null : v; }
  async exists(p: string, ref: string) { return p in this.trees.get(this.commits.get(ref)!.tree)!; }
  async listWorkflowRuns() { return []; }
}

const seed = () => ({
  "config/content-index.json": json(registry(3)),
  "howto/index.html": '<li data-slug="wiki-skill"></li>',
  "howto/wiki-skill/index.html": "<html>ok</html>",
  "howto/wiki-skill/index.meta.json": meta("wiki-skill"),
});
const deps = (gh: FakeGithub): ServiceDeps => ({ gh, config, signingSecret: "s3cret", allowedBranches: ["main", "xpf-smoke"] });
const addReq = (over: Partial<PublishRequest> = {}, slug = "new-guide", id = "0004"): PublishRequest => ({
  ref: `howto/${slug}`, verb: "add", intent: { summary: "first", actor: "agent:claude-code" },
  bundle: {
    changes: [
      put(`howto/${slug}/index.html`, "<html>guide</html>"),
      put(`howto/${slug}/index.meta.json`, meta(slug)),
      put("howto/index.html", `<li data-slug="wiki-skill"></li><li data-slug="${slug}"></li>`),
      put("config/content-index.json", json(registry(parseInt(id, 10), [{ id, type: "howto", slug }]))),
    ],
  },
  ...over,
});

describe("publish service", () => {
  it("commits atomically, merges the registry onto head, and signs the commit", async () => {
    const gh = new FakeGithub(seed());
    const head0 = gh.refs.get("main")!;
    const r = await publish(deps(gh), addReq());
    expect(r.status).toBe("committed");
    if (r.status !== "committed") return;
    expect(gh.refs.get("main")).toBe(r.commit_sha);
    const c = gh.commits.get(r.commit_sha)!;
    expect(c.parents).toEqual([head0]);
    const files = gh.files("main");
    expect(files["howto/new-guide/index.html"]).toBe("<html>guide</html>");
    expect(JSON.parse(files["config/content-index.json"]).counters.howto).toBe(4);
    expect(c.message).toMatch(/^feat\(howto\): add new-guide \[HT·0004\]/);
    expect(c.message).toContain("Published-via: xpf-cms");
    const sig = /Xpf-Sig: ([0-9a-f]{64})/.exec(c.message)![1];
    expect(sig).toBe(await signCommit("s3cret", c.tree, head0, "howto/new-guide"));
    expect(sig).not.toBe(await signCommit("wrong", c.tree, head0, "howto/new-guide"));
  });

  it("dry-run validates without touching the repo", async () => {
    const gh = new FakeGithub(seed());
    const head0 = gh.refs.get("main")!;
    const r = await publish(deps(gh), addReq({ dry_run: true }));
    expect(r.status).toBe("dry_run");
    expect(gh.refs.get("main")).toBe(head0);
    expect(gh.commits.size).toBe(1);
  });

  it("rejects an invalid bundle with findings and no commit", async () => {
    const gh = new FakeGithub(seed());
    const req = addReq(); req.bundle.changes[0] = put("howto/new-guide/index.html", "<p>冯晓平</p>");
    const r = await publish(deps(gh), req);
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.plan.findings.map(f => f.code)).toContain("author-name");
    expect(gh.commits.size).toBe(1);
  });

  it("reports a conflict when a replaced file changed upstream since base_sha", async () => {
    const gh = new FakeGithub(seed());
    const base = gh.refs.get("main")!;
    gh.land("main", { "howto/index.html": '<li data-slug="wiki-skill"></li><li data-slug="someone-else"></li>' });
    const r = await publish(deps(gh), addReq({ bundle: { ...addReq().bundle, base_sha: base } }));
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") expect(r.conflicts).toEqual(["howto/index.html"]);
  });

  it("does not treat a registry-only upstream change as a conflict", async () => {
    const gh = new FakeGithub(seed());
    const base = gh.refs.get("main")!;
    gh.land("main", { "config/content-index.json": json(registry(3)) + " " });   // touched, still valid JSON
    const r = await publish(deps(gh), addReq({ bundle: { ...addReq().bundle, base_sha: base } }));
    expect(r.status).toBe("committed");
  });

  it("re-plans when the branch moves mid-publish, and the id check catches a lost race", async () => {
    const gh = new FakeGithub(seed());
    // another publish claims id 0004 right before our ref update
    gh.hookBeforeUpdateRef = () => gh.land("main", { "config/content-index.json": json(registry(4, [{ id: "0004", type: "howto", slug: "other" }])) });
    const r = await publish(deps(gh), addReq());
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.plan.findings.map(f => f.code)).toContain("id-not-fresh");
  });

  it("retries onto the new head when the race is harmless", async () => {
    const gh = new FakeGithub(seed());
    gh.hookBeforeUpdateRef = () => gh.land("main", { "README.md": "unrelated" });
    const r = await publish(deps(gh), addReq());
    expect(r.status).toBe("committed");
    expect(gh.files("main")["README.md"]).toBe("unrelated");     // our commit sits on top of theirs
  });

  it("auto-creates the smoke branch from main and keeps main untouched", async () => {
    const gh = new FakeGithub(seed());
    const main0 = gh.refs.get("main")!;
    const r = await publish(deps(gh), addReq({ branch: "xpf-smoke" }));
    expect(r.status).toBe("committed");
    expect(gh.refs.get("main")).toBe(main0);
    expect(gh.files("xpf-smoke")["howto/new-guide/index.html"]).toBeDefined();
  });

  it("refuses disallowed branches and unsafe paths", async () => {
    const gh = new FakeGithub(seed());
    await expect(publish(deps(gh), addReq({ branch: "gh-pages" }))).rejects.toMatchObject({ status: 403 });
    const bad = addReq(); bad.bundle.changes.push(put("howto/new-guide/../../../etc/x", "x"));
    await expect(publish(deps(gh), bad)).rejects.toBeInstanceOf(HttpError);
    const git = addReq(); git.bundle.changes.push(put(".git/config", "x"));
    await expect(publish(deps(gh), git)).rejects.toMatchObject({ status: 400 });
  });

  it("stores binary files as blobs and applies deletions", async () => {
    const gh = new FakeGithub({ ...seed(), "howto/wiki-skill/old.png": "x" });
    const req: PublishRequest = {
      ref: "howto/wiki-skill", verb: "update",
      bundle: { changes: [
        { path: "howto/wiki-skill/new.png", op: "put", encoding: "base64", content: "AAEC", size: 3 },
        { path: "howto/wiki-skill/old.png", op: "delete" },
        put("howto/wiki-skill/index.html", "<html>v2</html>"),
      ] },
    };
    const r = await publish(deps(gh), req);
    expect(r.status).toBe("committed");
    expect(gh.blobs).toEqual(["AAEC"]);
    expect(gh.files("main")["howto/wiki-skill/old.png"]).toBeUndefined();
    expect(gh.files("main")["howto/wiki-skill/new.png"]).toBe("<blob:blob1>");
  });
});
