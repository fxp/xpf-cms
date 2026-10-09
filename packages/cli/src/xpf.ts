#!/usr/bin/env tsx
import { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, loadSite, validateSite, renderReport, buildMarkdownFace, patchAgentsTxt } from "@xpf/core";
import { buildDashboard, loadInfraSnapshot, saveInfraSnapshot, DEFAULT_INFRA_JSON } from "@xpf/admin";

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

prog.parseAsync();
