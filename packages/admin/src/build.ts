import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, loadSite, validateSite } from "@xpf/core";
import { buildQueues } from "./queues.ts";
import { loadInfraSnapshot } from "./infra.ts";
import { renderDashboard } from "./render.ts";

export interface BuildDashboardOpts { site: string; out: string; backups?: string; }

export function buildDashboard(opts: BuildDashboardOpts) {
  const config = loadConfig();
  const site = loadSite(path.resolve(opts.site), config);
  const { findings, stats } = validateSite(site);
  const queues = buildQueues(site, findings);
  const infra = loadInfraSnapshot(path.resolve(opts.backups ?? path.join(os.homedir(), "Backups/xpf")));
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const html = renderDashboard({ site, findings, stats, queues, infra, generatedAt });
  mkdirSync(path.resolve(opts.out), { recursive: true });
  writeFileSync(path.join(path.resolve(opts.out), "index.html"), html, "utf8");

  const data = {
    generatedAt, stats,
    findingsCount: findings.length,
    queueCounts: Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, (v as any[]).length])),
    infra: { date: infra.date, counts: infra.counts, delta: infra.delta },
  };
  writeFileSync(path.join(path.resolve(opts.out), "data.json"), JSON.stringify(data, null, 2), "utf8");
  writeFileSync(path.join(path.resolve(opts.out), "_headers"), "/*\n  X-Robots-Tag: noindex, nofollow\n  Cache-Control: no-store\n", "utf8");

  return { stats, findingsCount: findings.length, queueCounts: data.queueCounts, outDir: path.resolve(opts.out) };
}
