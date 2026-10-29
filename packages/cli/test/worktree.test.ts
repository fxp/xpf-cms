import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listChangedPaths, collectWorktreeChanges } from "../src/worktree.ts";

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "xpf-wt-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  const write = (p: string, body = "x") => { mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); writeFileSync(path.join(dir, p), body); };
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
  write("howto/a/index.html", "a"); write("howto/index.html", "list"); write("_redirects", "r"); write("old.txt", "o");
  git("add", "-A"); git("commit", "-q", "-m", "init");
  return { dir, git, write, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("listChangedPaths", () => {
  it("lists modified, deleted and untracked files (nested ones individually) and both ends of a rename", () => {
    const r = repo();
    try {
      r.write("howto/a/index.html", "changed");
      r.write("howto/b/media/pic.png", "p");
      rmSync(path.join(r.dir, "_redirects"));
      r.git("mv", "old.txt", "new.txt");
      expect(listChangedPaths(r.dir)).toEqual(["_redirects", "howto/a/index.html", "howto/b/media/pic.png", "new.txt", "old.txt"]);
    } finally { r.done(); }
  });
  it("is empty on a clean tree", () => {
    const r = repo(); try { expect(listChangedPaths(r.dir)).toEqual([]); } finally { r.done(); }
  });
  it("the paths a publish would leave behind are exactly the ones collectWorktreeChanges drops", () => {
    const r = repo();
    try {
      r.write("howto/a/index.html", "changed"); r.write("_redirects", "changed too");
      const keep = (p: string) => p.startsWith("howto/a/");
      const sent = collectWorktreeChanges(r.dir, keep).map(c => c.path);
      const left = listChangedPaths(r.dir).filter(p => !keep(p));
      expect(sent).toEqual(["howto/a/index.html"]);
      expect(left).toEqual(["_redirects"]);
    } finally { r.done(); }
  });
});
