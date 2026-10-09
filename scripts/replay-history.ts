#!/usr/bin/env tsx
// Dev tool: replay real publish commits from the site's history through planPublish() to see what the
// rules would have said. Used to calibrate false positives before the gate is turned on.
//   tsx scripts/replay-history.ts [--site ~/Code/xiaopingfeng-site] [--per-pattern 3]
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { loadConfig, planPublish, ownershipFor, isDerived, type BundleChange } from "../packages/core/src/index.ts";
import { GitView } from "../packages/cli/src/worktree.ts";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const root = path.resolve(opt("--site", path.join(os.homedir(), "Code/xiaopingfeng-site")));
const perPattern = parseInt(opt("--per-pattern", "3"), 10);
const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { maxBuffer: 512 * 1024 * 1024 });
const config = loadConfig();

const ONLY = opt("--only", "");
const PATTERNS = ONLY ? [ONLY] : [
  "feat(deepdive): publish", "feat(buzzwords): publish", "howto: add", "feat(predictions): add", "feat(research): add",
  "feat(notes): add", "feat(apps): add", "feat(skills): add", "feat(landscape)", "fix(predictions)", "fix(research)", "howto: update",
  "chore(apps): remove", "chore(research): remove", "chore(deepdive): remove",
];

function verbOf(subject: string) { return /\bremove\b/.test(subject) ? "remove" : /\b(add|publish)\b/.test(subject) ? "add" : "update"; }

const rows: string[] = [];
for (const pat of PATTERNS) {
  const hashes = git("log", "--format=%h", `--grep=${pat}`, "-F", "-n", String(perPattern)).toString().trim().split("\n").filter(Boolean);
  for (const h of hashes) {
    const subject = git("log", "-1", "--format=%s", h).toString().trim();
    const m = subject.match(/^\w+\((\w+)\): (?:add|publish|update|fix|remove)\s+(?:EP\.)?([\w./-]+)/) ?? subject.match(/^\w+\((buzzwords)\): EP\.(\d+)/) ?? subject.match(/^howto: (?:add|update) ([\w-]+)/);
    if (!m) { rows.push(`? ${h} ${subject.slice(0, 80)}  (cannot parse a ref)`); continue; }
    const type = m.length === 3 ? m[1] : "howto";
    const slug = m.length === 3 ? m[2] : m[1];
    const ref = `${type}/${slug}`;
    const verb = verbOf(subject);
    const names = git("diff-tree", "--no-commit-id", "--name-status", "-r", "--no-renames", h).toString().trim().split("\n").filter(Boolean).map(l => l.split("\t") as [string, string]);
    // find the item dir in the commit's tree (or its parent for removals)
    const v = config.verticals[type];
    if (!v) { rows.push(`? ${h} ${subject.slice(0, 70)}  (unknown vertical ${type})`); continue; }
    const candidates = type === "buzzwords" ? [`buzzwords/${slug}`] : v.dirs.map(d => `${d}/${slug}`);
    const treeHas = (rev: string, p: string) => { try { git("cat-file", "-e", `${rev}:${p}`); return true; } catch { return false; } };
    const itemDir = candidates.find(c => treeHas(h, `${c}/index.html`) || treeHas(`${h}^`, `${c}/index.html`)) ?? candidates[0];
    const own = ownershipFor(config, type, itemDir);
    const changes: BundleChange[] = [];
    for (const [st, p] of names) {
      if (!(own(p) || isDerived(config, p))) continue;
      if (st === "D") { changes.push({ path: p, op: "delete" }); continue; }
      const buf = git("show", `${h}:${p}`);
      let text: string | null = null; try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch {}
      changes.push(text !== null ? { path: p, op: "put", encoding: "utf8", content: text, size: buf.length } : { path: p, op: "put", encoding: "base64", content: buf.toString("base64"), size: buf.length });
    }
    const plan = await planPublish(new GitView(root, `${h}^`), { changes }, { ref, verb, itemDir }, config);
    const errs = plan.findings.filter(f => f.severity === "error");
    const warns = plan.findings.filter(f => f.severity === "warning");
    rows.push(`${plan.ok ? "OK " : "ERR"} ${h} ${verb.padEnd(6)} ${ref.padEnd(46)} files=${plan.changes.length} derived-skipped=${plan.skippedDerived.length} warn=${warns.length}` +
      errs.map(e => `\n      ✗ ${e.code}: ${e.message.slice(0, 140)}`).join("") + warns.map(e => `\n      ! ${e.code}: ${e.message.slice(0, 110)}`).join(""));
  }
}
console.log(rows.join("\n"));
