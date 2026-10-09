import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BundleChange, FileView, XpfConfig } from "@xpf/core";

function git(root: string, args: string[], opts: { allowFail?: boolean } = {}): Buffer | null {
  try { return execFileSync("git", ["-C", root, ...args], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { if (opts.allowFail) return null; throw e; }
}

/** The tree as committed at `rev` (default HEAD): the "base" a publish is judged against. */
export class GitView implements FileView {
  constructor(private root: string, private rev = "HEAD") {}
  async read(p: string): Promise<string | null> {
    const b = git(this.root, ["show", `${this.rev}:${p}`], { allowFail: true });
    if (!b) return null;
    try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; }
  }
  async exists(p: string): Promise<boolean> { return git(this.root, ["cat-file", "-e", `${this.rev}:${p}`], { allowFail: true }) !== null; }
}

export function headSha(root: string): string { return git(root, ["rev-parse", "HEAD"])!.toString().trim(); }
export function currentBranch(root: string): string { return git(root, ["branch", "--show-current"])!.toString().trim(); }
/** [ahead, behind] of HEAD relative to origin/main, after a fetch. */
export function aheadBehind(root: string): [number, number] {
  git(root, ["fetch", "-q", "origin"], { allowFail: true });
  const out = git(root, ["rev-list", "--left-right", "--count", "HEAD...origin/main"], { allowFail: true });
  if (!out) return [0, 0];
  const [a, b] = out.toString().trim().split(/\s+/).map(Number);
  return [a, b];
}

/** Working-tree changes (vs HEAD) whose path satisfies `keep`. Untracked files are listed individually. */
export function collectWorktreeChanges(root: string, keep: (p: string) => boolean): BundleChange[] {
  const raw = git(root, ["status", "--porcelain=v1", "-z", "-uall"])!.toString("utf8");
  const parts = raw.split("\0").filter(Boolean);
  const out = new Map<string, BundleChange>();
  const put = (p: string) => {
    if (!keep(p)) return;
    const abs = path.join(root, p);
    if (!existsSync(abs)) { out.set(p, { path: p, op: "delete" }); return; }
    const buf = readFileSync(abs);
    let text: string | null = null;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { /* binary */ }
    out.set(p, text !== null
      ? { path: p, op: "put", encoding: "utf8", content: text, size: buf.length }
      : { path: p, op: "put", encoding: "base64", content: buf.toString("base64"), size: buf.length });
  };
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    const xy = rec.slice(0, 2);
    const file = rec.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {          // rename/copy: next record is the origin path
      const from = parts[++i];
      if (xy[0] === "R" && keep(from)) out.set(from, { path: from, op: "delete" });
      put(file);
      continue;
    }
    if (xy.includes("D")) { if (keep(file)) out.set(file, { path: file, op: "delete" }); continue; }
    put(file);
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Item directory as it exists in the working tree (first vertical dir that has it). */
export function resolveItemDirFs(root: string, config: XpfConfig, type: string, slug: string): string | null {
  const v = config.verticals[type];
  if (!v) return null;
  const candidates = type === "buzzwords" ? [`buzzwords/${slug}`] : v.dirs.map(d => `${d}/${slug}`);
  return candidates.find(c => existsSync(path.join(root, c, "index.html")) || existsSync(path.join(root, c, "index.meta.json"))) ?? null;
}

/** After a successful publish on main: make the local checkout equal to what the Worker committed, so a later
 * `git pull` has nothing to fight with. Sent paths are staged at their remote content, then main fast-forwards.
 * Returns an error message when the fast-forward could not be done (the caller prints the manual recipe). */
export function syncAfterPublish(root: string, changes: BundleChange[], skip: Set<string> = new Set()): string | null {
  try {
    git(root, ["fetch", "-q", "origin", "main"]);
    for (const c of changes) {
      if (skip.has(c.path)) continue;
      if (c.op === "put") git(root, ["checkout", "origin/main", "--", c.path], { allowFail: true });
      else git(root, ["rm", "-q", "--cached", "--ignore-unmatch", "--", c.path], { allowFail: true });
    }
    git(root, ["merge", "--ff-only", "-q", "origin/main"]);
    return null;
  } catch (e: any) {
    return String(e?.stderr ?? e?.message ?? e).trim().split("\n").slice(0, 3).join(" | ");
  }
}
