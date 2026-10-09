// Publish orchestration, independent of Hono / Workers bindings so it can be tested against an
// in-memory GitHub. One call = validate against the *current* branch head, then one atomic commit.
import { planPublish, parseRef, type Bundle, type PublishIntent, type PublishPlan, type PublishFinding, type XpfConfig, type Verb } from "@xpf/core/edge";
import { GithubView, RefMovedError, type GithubLike, type TreeEntry } from "./github.ts";
import { signCommit } from "./sign.ts";

export interface PublishRequest {
  ref: string;
  verb: Verb;
  intent?: Partial<Omit<PublishIntent, "ref" | "verb">>;
  bundle: Bundle;
  branch?: string;
  dry_run?: boolean;
}
export interface ServiceDeps {
  gh: GithubLike;
  config: XpfConfig;
  signingSecret: string;
  /** branches a publish may target; the first is the default (main). Others are auto-created from main. */
  allowedBranches: string[];
}
export type PublishResult =
  | { status: "dry_run"; plan: PublishPlan; head: string; branch: string }
  | { status: "rejected"; plan: PublishPlan; head: string; branch: string }
  | { status: "conflict"; conflicts: string[]; head: string; branch: string; message: string }
  | { status: "committed"; plan: PublishPlan; branch: string; commit_sha: string; parent: string };

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

const AUTHOR = { name: "xpf-cms", email: "xpf-cms@xiaopingfeng.com" };
const MAX_ATTEMPTS = 3;

function safePath(p: string): boolean {
  return !!p && !p.startsWith("/") && !p.includes("\\") && !p.split("/").some(s => s === ".." || s === "." || s === "" || s === ".git");
}

export async function publish(deps: ServiceDeps, req: PublishRequest): Promise<PublishResult> {
  const { gh, config } = deps;
  const branch = req.branch ?? deps.allowedBranches[0];
  if (!deps.allowedBranches.includes(branch)) throw new HttpError(403, `branch "${branch}" is not allowed (allowed: ${deps.allowedBranches.join(", ")})`);
  try { parseRef(req.ref); } catch (e: any) { throw new HttpError(400, e.message); }
  for (const c of req.bundle.changes) if (!safePath(c.path)) throw new HttpError(400, `unsafe path "${c.path}"`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let head = await gh.getRef(branch);
    if (!head) {
      if (branch === deps.allowedBranches[0]) throw new HttpError(500, `${branch} does not exist`);
      const main = await gh.getRef(deps.allowedBranches[0]);
      if (!main) throw new HttpError(500, `${deps.allowedBranches[0]} does not exist`);
      if (!req.dry_run) await gh.createRef(branch, main.sha);
      head = main;
    }

    // The bundle was authored against base_sha. Anything it replaces wholesale must not have changed upstream since.
    const base = req.bundle.base_sha;
    if (base && base !== head.sha) {
      const upstream = new Set(await gh.compareFiles(base, head.sha));
      const registry = config.publish.registry;
      const clash = req.bundle.changes.map(c => c.path).filter(p => p !== registry && upstream.has(p));
      if (clash.length) return { status: "conflict", conflicts: clash, head: head.sha, branch, message: `${clash.length} file(s) changed on ${branch} since your base ${base.slice(0, 8)}; pull and re-run` };
    }

    const view = new GithubView(gh, head.sha);
    const plan = await planPublish(view, req.bundle, { ...req.intent, ref: req.ref, verb: req.verb }, config);
    if (!plan.ok) return { status: "rejected", plan, head: head.sha, branch };
    if (req.dry_run) return { status: "dry_run", plan, head: head.sha, branch };

    try {
      const parent = await gh.getCommit(head.sha);
      const entries: TreeEntry[] = [];
      for (const c of plan.changes) {
        if (c.op === "delete") entries.push({ path: c.path, mode: "100644", type: "blob", sha: null });
        else if ((c.encoding ?? "utf8") === "utf8") entries.push({ path: c.path, mode: "100644", type: "blob", content: c.content ?? "" });
        else entries.push({ path: c.path, mode: "100644", type: "blob", sha: await gh.createBlob(c.content ?? "") });
      }
      const tree = await gh.createTree(parent.tree, entries);
      const sig = await signCommit(deps.signingSecret, tree, head.sha, plan.ref);
      const message = `${plan.commit.message.trimEnd()}\nXpf-Sig: ${sig}\n`;
      const sha = await gh.createCommit({ message, tree, parents: [head.sha], author: AUTHOR });
      await gh.updateRef(branch, sha);
      return { status: "committed", plan, branch, commit_sha: sha, parent: head.sha };
    } catch (e) {
      if (e instanceof RefMovedError && attempt < MAX_ATTEMPTS) continue;   // someone else landed first: re-plan on the new head
      throw e;
    }
  }
  throw new HttpError(409, `${branch} kept moving; try again`);
}

export function summarize(plan: PublishPlan) {
  const count = (s: PublishFinding["severity"]) => plan.findings.filter(f => f.severity === s).length;
  return { ok: plan.ok, id: plan.id, itemDir: plan.itemDir, files: plan.changes.map(c => ({ path: c.path, op: c.op, size: c.size })), skippedDerived: plan.skippedDerived, errors: count("error"), warnings: count("warning"), findings: plan.findings, commit: plan.commit.subject };
}
