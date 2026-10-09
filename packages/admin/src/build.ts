import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig, loadSite, validateSite } from "@xpf/core";
import { buildQueues } from "./queues.ts";
import { fileURLToPath } from "node:url";
import { loadInfraSnapshot, loadInfraFromFile } from "./infra.ts";
import { renderDashboard } from "./render.ts";

/** Committed fallback used when the local backups tree is absent (CI). Refresh it with `xpf build infra`. */
export const DEFAULT_INFRA_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/infra-latest.json");

export interface BuildDashboardOpts { site: string; out: string; backups?: string; infraJson?: string; }

export function buildDashboard(opts: BuildDashboardOpts) {
  const config = loadConfig();
  const site = loadSite(path.resolve(opts.site), config);
  const { findings, stats } = validateSite(site);
  const queues = buildQueues(site, findings);
  const local = loadInfraSnapshot(path.resolve(opts.backups ?? path.join(os.homedir(), "Backups/xpf")));
  const infra = local.date ? local : loadInfraFromFile(path.resolve(opts.infraJson ?? DEFAULT_INFRA_JSON));
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
