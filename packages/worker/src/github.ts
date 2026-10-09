import type { FileView } from "@xpf/core/edge";

/** The slice of the GitHub API the publish path needs. Narrow on purpose: tests fake it in memory. */
export interface GithubLike {
  getRef(branch: string): Promise<{ sha: string } | null>;
  createRef(branch: string, sha: string): Promise<void>;
  getCommit(sha: string): Promise<{ sha: string; tree: string }>;
  createBlob(base64: string): Promise<string>;
  createTree(baseTree: string, entries: TreeEntry[]): Promise<string>;
  createCommit(input: { message: string; tree: string; parents: string[]; author: { name: string; email: string } }): Promise<string>;
  /** Fast-forward only. Throws RefMovedError when the branch moved. */
  updateRef(branch: string, sha: string): Promise<void>;
  compareFiles(base: string, head: string): Promise<string[]>;
  getText(path: string, ref: string): Promise<string | null>;
  exists(path: string, ref: string): Promise<boolean>;
  listWorkflowRuns(workflowFile: string, headSha: string): Promise<WorkflowRun[]>;
}
export interface TreeEntry { path: string; mode: "100644"; type: "blob"; sha?: string | null; content?: string; }
export interface WorkflowRun { id: number; status: string; conclusion: string | null; html_url: string; head_sha: string; }

export class GithubError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = "GithubError"; }
}
export class RefMovedError extends Error {
  constructor(branch: string) { super(`${branch} moved while publishing`); this.name = "RefMovedError"; }
}

export class GithubClient implements GithubLike {
  constructor(private token: string, private repo: string, private fetchImpl: typeof fetch = fetch, private base = "https://api.github.com") {}

  private async req(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<Response> {
    return this.fetchImpl(`${this.base}/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`, accept, "x-github-api-version": "2022-11-28", "user-agent": "xpf-cms",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.req(method, path, body);
    if (!r.ok) throw new GithubError(r.status, `${method} ${path} → ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<T>;
  }
  private static seg(p: string) { return p.split("/").map(encodeURIComponent).join("/"); }

  async getRef(branch: string) {
    const r = await this.req("GET", `/git/ref/heads/${GithubClient.seg(branch)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new GithubError(r.status, `getRef ${branch} → ${r.status}`);
    return { sha: ((await r.json()) as any).object.sha as string };
  }
  async createRef(branch: string, sha: string) { await this.json("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha }); }
  async getCommit(sha: string) { const c = await this.json<any>("GET", `/git/commits/${sha}`); return { sha: c.sha as string, tree: c.tree.sha as string }; }
  async createBlob(base64: string) { return (await this.json<any>("POST", "/git/blobs", { content: base64, encoding: "base64" })).sha as string; }
  async createTree(baseTree: string, entries: TreeEntry[]) { return (await this.json<any>("POST", "/git/trees", { base_tree: baseTree, tree: entries })).sha as string; }
  async createCommit(i: { message: string; tree: string; parents: string[]; author: { name: string; email: string } }) {
    const when = new Date().toISOString();
    return (await this.json<any>("POST", "/git/commits", { message: i.message, tree: i.tree, parents: i.parents, author: { ...i.author, date: when }, committer: { ...i.author, date: when } })).sha as string;
  }
  async updateRef(branch: string, sha: string) {
    const r = await this.req("PATCH", `/git/refs/heads/${GithubClient.seg(branch)}`, { sha, force: false });
    if (r.status === 422) throw new RefMovedError(branch);
    if (!r.ok) throw new GithubError(r.status, `updateRef ${branch} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  async compareFiles(base: string, head: string) {
    const c = await this.json<any>("GET", `/compare/${base}...${head}`);
    return (c.files ?? []).map((f: any) => f.filename as string);
  }
  async getText(path: string, ref: string) {
    const r = await this.req("GET", `/contents/${GithubClient.seg(path)}?ref=${encodeURIComponent(ref)}`, undefined, "application/vnd.github.raw+json");
    if (r.status === 404) return null;
    if (!r.ok) throw new GithubError(r.status, `getText ${path}@${ref} → ${r.status}`);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(await r.arrayBuffer()); } catch { return null; }
  }
  async exists(path: string, ref: string) {
    const r = await this.req("GET", `/contents/${GithubClient.seg(path)}?ref=${encodeURIComponent(ref)}`);
    if (r.status === 404) return false;
    if (!r.ok) throw new GithubError(r.status, `exists ${path}@${ref} → ${r.status}`);
    await r.arrayBuffer();
    return true;
  }
  async listWorkflowRuns(workflowFile: string, headSha: string) {
    const j = await this.json<any>("GET", `/actions/workflows/${workflowFile}/runs?head_sha=${headSha}&per_page=5`);
    return (j.workflow_runs ?? []).map((w: any) => ({ id: w.id, status: w.status, conclusion: w.conclusion, html_url: w.html_url, head_sha: w.head_sha })) as WorkflowRun[];
  }
}

/** FileView over one commit of the repo, with a per-request cache. */
export class GithubView implements FileView {
  private text = new Map<string, Promise<string | null>>();
  private ex = new Map<string, Promise<boolean>>();
  constructor(private gh: GithubLike, private ref: string) {}
  read(p: string) { if (!this.text.has(p)) this.text.set(p, this.gh.getText(p, this.ref)); return this.text.get(p)!; }
  exists(p: string) { if (!this.ex.has(p)) this.ex.set(p, this.gh.exists(p, this.ref)); return this.ex.get(p)!; }
}
