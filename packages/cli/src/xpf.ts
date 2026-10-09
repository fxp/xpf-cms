#!/usr/bin/env tsx
import { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, loadSite, validateSite, renderReport, buildMarkdownFace, patchAgentsTxt, planPublish, ownershipFor, isDerived, parseRef, type Verb, type PublishPlan } from "@xpf/core";
import { buildDashboard, loadInfraSnapshot, saveInfraSnapshot, DEFAULT_INFRA_JSON } from "@xpf/admin";
import { GitView, headSha, currentBranch, aheadBehind, collectWorktreeChanges, resolveItemDirFs, syncAfterPublish } from "./worktree.ts";
import { loadClientConfig, postJson } from "./client.ts";

const prog = new Command().name("xpf").description("xpf-cms · Agent-first Artifact Management System CLI").version("0.1.0");
const siteOpt = (c: Command) => c.option("-s, --site <dir>", "site repo root", path.join(os.homedir(), "code/xiaopingfeng-site"));

siteOpt(prog.command("validate").description("read-only health check of the site repo"))
  .option("--json", "print JSON findings")
  .option("--report <file>", "write markdown report")
  .action((o) => {
    const site = loadSite(path.resolve(o.site), loadConfig());
    const res = validateSite(site);
    const date = new Date().toISOString().slice(0, 10);
    if (o.json) console.log(JSON.stringify({ stats: res.stats, findings: res.findings }, null, 2));
    else {
      const e = res.findings.filter(f => f.severity === "error").length, w = res.findings.filter(f => f.severity === "warning").length;
      console.log(`items=${res.stats.items} public=${res.stats.public} errors=${e} warnings=${w} info=${res.findings.length - e - w}`);
      const byCode = new Map<string, number>(); for (const f of res.findings) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
      for (const [c, n] of [...byCode].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${c}`);
    }
    if (o.report) { mkdirSync(path.dirname(o.report), { recursive: true }); writeFileSync(o.report, renderReport(site, res, date)); console.log(`report → ${o.report}`); }
    process.exitCode = res.findings.some(f => f.severity === "error") ? 1 : 0;
  });

const build = prog.command("build").description("build derived artifacts");
siteOpt(build.command("llms").description("Markdown face: index.md, llms.txt per item/vertical/site, llms-full.txt"))
  .requiredOption("-o, --out <dir>", "output dir (mirrors site layout)")
  .option("--only <types>", "comma-separated vertical types")
  .option("--max-full <n>", "max chars per item in llms-full.txt", "80000")
  .option("--overwrite-llms", "regenerate llms.txt even where an authored one exists")
  .action((o) => {
    const site = loadSite(path.resolve(o.site), loadConfig());
    const stats = buildMarkdownFace(site, { outDir: path.resolve(o.out), only: o.only?.split(","), maxFullChars: parseInt(o.maxFull, 10), skipExisting: !o.overwriteLlms });
    const patched = patchAgentsTxt(site.root, { outDir: path.resolve(o.out) }, site.config.site.base_url);
    console.log(JSON.stringify({ ...stats, agentsTxtPatched: patched }, null, 2));
  });

siteOpt(build.command("dashboard").description("static ops dashboard: queues, verticals, infra snapshot, recent items"))
  .requiredOption("-o, --out <dir>", "output dir (writes index.html, data.json, _headers)")
  .option("--backups <dir>", "~/Backups/xpf-style directory to read infra snapshots from", path.join(os.homedir(), "Backups/xpf"))
  .option("--infra-json <file>", "committed infra snapshot used when --backups has none (CI)", DEFAULT_INFRA_JSON)
  .action((o) => {
    const res = buildDashboard({ site: o.site, out: o.out, backups: o.backups, infraJson: o.infraJson });
    console.log(JSON.stringify(res, null, 2));
  });

build.command("infra").description("write the committed infra snapshot (data/infra-latest.json) from the local ~/Backups/xpf tree")
  .option("--backups <dir>", "backups root", path.join(os.homedir(), "Backups/xpf"))
  .option("-o, --out <file>", "output file", DEFAULT_INFRA_JSON)
  .action((o) => {
    const snap = loadInfraSnapshot(path.resolve(o.backups));
    if (!snap.date) { console.error(`no snapshot found under ${o.backups}`); process.exitCode = 1; return; }
    saveInfraSnapshot(snap, path.resolve(o.out));
    console.log(`infra snapshot ${snap.date} → ${path.resolve(o.out)}`);
  });

// ---- publish / update / remove --------------------------------------------------------------------
// The write path for site content: collect this item's owned changes from the working tree, judge the
// resulting tree with the same planPublish() the cms Worker runs, and (once the Worker exists) hand the
// bundle over for an atomic commit. Until then only --dry-run is available.
function fmtSize(n = 0) { return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`; }

async function runPublish(verb: Verb, ref: string, o: any) {
  const root = path.resolve(o.site);
  const config = loadConfig();
  const { type, slug } = parseRef(ref);
  if (!config.verticals[type]) { console.error(`unknown vertical "${type}"`); process.exitCode = 2; return; }
  const itemDir: string | null = o.itemDir ?? resolveItemDirFs(root, config, type, slug);
  const ownDir = itemDir ?? (type === "buzzwords" ? `buzzwords/${slug}` : `${config.verticals[type].dirs[0]}/${slug}`);
  const owned = ownershipFor(config, type, ownDir, o.also ?? []);
  const keep = (p: string) => owned(p) || isDerived(config, p);

  const branch = currentBranch(root);
  const [ahead, behind] = aheadBehind(root);
  const bundle = { base_sha: headSha(root), changes: collectWorktreeChanges(root, keep) };
  const plan: PublishPlan = await planPublish(new GitView(root), bundle, {
    ref, verb, summary: o.summary, actor: o.actor, calendar: !!o.calendar, also: o.also, itemDir: itemDir ?? undefined,
    placeholder: !!o.placeholder, derive: o.derive !== false,
  }, config);
  // environment checks only the CLI can make
  if (branch !== "main") plan.findings.push({ severity: "error", code: "not-on-main", message: `site checkout is on "${branch}", not main` });
  if (behind > 0) plan.findings.push({ severity: "error", code: "behind-origin", message: `local main is ${behind} commit(s) behind origin/main; git pull --ff-only first` });
  if (ahead > 0) plan.findings.push({ severity: "warning", code: "ahead-of-origin", message: `local main has ${ahead} unpushed commit(s); they are not part of this publish` });
  plan.ok = !plan.findings.some(f => f.severity === "error");

  if (o.json) { console.log(JSON.stringify({ ...plan, changes: plan.changes.map(c => ({ path: c.path, op: c.op, size: c.size })), base_sha: bundle.base_sha }, null, 2)); }
  else {
    const errs = plan.findings.filter(f => f.severity === "error").length, warns = plan.findings.filter(f => f.severity === "warning").length;
    console.log(`${plan.ok ? "✓" : "✗"} ${verb} ${ref}${plan.id ? `  id ${plan.id}` : ""}   branch ${branch} (ahead ${ahead}, behind ${behind})   base ${bundle.base_sha.slice(0, 8)}`);
    console.log(`  item dir: ${plan.itemDir ?? "(not found)"}`);
    console.log(`  ${plan.changes.length} file(s) to commit${plan.skippedDerived.length ? `, ${plan.skippedDerived.length} derived skipped` : ""}:`);
    for (const c of plan.changes) console.log(`    ${c.op === "delete" ? "delete" : "put   "} ${c.path}${c.op === "put" ? `  (${fmtSize(c.size)})` : ""}`);
    console.log(`  findings: ${errs} error(s), ${warns} warning(s)`);
    for (const f of plan.findings) console.log(`    ${f.severity === "error" ? "✗" : f.severity === "warning" ? "!" : "·"} ${f.code}${f.path ? ` [${f.path}]` : ""}: ${f.message}`);
    if (plan.commit.subject) console.log(`  commit:\n${plan.commit.message.split("\n").map(l => "    " + l).join("\n")}`);
  }
  if (!plan.ok) { process.exitCode = 1; return; }

  const intent = { summary: o.summary, actor: o.actor, calendar: !!o.calendar, also: o.also, itemDir: itemDir ?? undefined, placeholder: !!o.placeholder, derive: o.derive !== false };
  const body = { ref, verb, intent, bundle: { base_sha: bundle.base_sha, changes: plan.changes }, branch: o.branch, dry_run: !!o.dryRun };
  if (o.dryRun && !o.remote) return;                       // local-only dry run
  const cfg = loadClientConfig();
  if (!cfg.token) { console.error(`\nno API token: set $XPF_API_TOKEN or write it to ~/.config/xpf/token (chmod 600)`); process.exitCode = 2; return; }
  const res = await postJson(cfg, "/api/publish", body);
  const j = res.json;
  if (res.status === 409) { console.error(`\n✗ conflict: ${j.message ?? j.error}\n  ${(j.conflicts ?? []).join("\n  ")}\n  fix: git pull --ff-only (stash first if needed), then re-run`); process.exitCode = 1; return; }
  if (res.status === 422) { console.error(`\n✗ rejected by ${cfg.api}:`); for (const f of j.plan?.findings ?? []) console.error(`    ${f.severity === "error" ? "✗" : "!"} ${f.code}: ${f.message}`); process.exitCode = 1; return; }
  if (res.status >= 400) { console.error(`\n✗ ${res.status} from ${cfg.api}: ${j.error ?? ""} ${j.detail ?? ""}`); process.exitCode = 1; return; }
  if (o.dryRun) { console.log(`\n✓ server also accepts it (head ${String(j.head).slice(0, 8)}, branch ${j.branch})`); return; }

  console.log(`\n✓ committed ${String(j.commit_sha).slice(0, 8)} on ${j.branch}  ${j.commit_url}`);
  if (j.instance_id) console.log(`  pipeline ${j.instance_id} (deploy wait + verify + index): xpf status ${j.instance_id}`);
  if (!o.branch) {
    const hadForeign = plan.findings.some(f => f.code === "registry-foreign-entries");
    const err = syncAfterPublish(root, plan.changes, hadForeign ? new Set([config.publish.registry]) : new Set());
    if (err) console.error(`  ! local checkout not fast-forwarded (${err}).\n    run: git stash && git pull --ff-only && git stash pop`);
    else console.log("  local checkout synced to origin/main");
  }
}

for (const verb of ["publish", "update", "remove"] as const) {
  const v: Verb = verb === "publish" ? "add" : verb;
  siteOpt(prog.command(`${verb} <ref>`).description(`${verb === "publish" ? "publish a new item" : verb === "update" ? "publish changes to an existing item" : "take an item down (registry tombstone)"} — <ref> is <type>/<slug>, e.g. howto/skill-state or buzzwords/106`))
    .option("--summary <text>", "commit body / change summary")
    .option("--actor <who>", "recorded in the commit trailer (human | agent:claude-code …)", process.env.XPF_ACTOR ?? "human")
    .option("--calendar", "tag the commit [content-update] so it appears on the homepage calendar")
    .option("--also <paths...>", "extra source paths this publish owns (e.g. _redirects)")
    .option("--item-dir <dir>", "item directory when it is not <vertical dir>/<slug>")
    .option("--placeholder", "allow a non-published meta.status (howto 'coming soon')")
    .option("--no-derive", "omit the 'Derive: pending' trailer")
    .option("--dry-run", "validate and show the plan; do not publish")
    .option("--remote", "with --dry-run: also ask the cms Worker to validate against the live branch head")
    .option("--branch <name>", "publish to this branch instead of main (smoke tests; skips local sync)")
    .option("--json", "print the plan as JSON")
    .action((ref, o) => runPublish(v, ref, o));
}

siteOpt(prog.command("status <instance>").description("status of a publish pipeline instance (deploy wait, verify, index)"))
  .action(async (instance) => {
    const cfg = loadClientConfig();
    const r = await fetch(`${cfg.api}/api/publish/${instance}`, { headers: { authorization: `Bearer ${cfg.token}` } });
    console.log(JSON.stringify(await r.json(), null, 2));
  });

prog.parseAsync();
