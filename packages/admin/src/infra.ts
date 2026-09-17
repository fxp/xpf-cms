import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface InfraSnapshot {
  date: string | null;
  counts: Record<string, number>;
  zones: string[];
  workers: { id: string }[];
  delta: Record<string, number> | null; // vs previous snapshot, if two exist
}

function loadJson(p: string): any | null {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function countsFor(dir: string): Record<string, number> {
  const gh = loadJson(path.join(dir, "github-repos.json"));
  const workers = loadJson(path.join(dir, "cf-workers.json"));
  const pages = loadJson(path.join(dir, "cf-pages.json"));
  const kv = loadJson(path.join(dir, "cf-kv.json"));
  const d1 = loadJson(path.join(dir, "cf-d1.json"));
  const r2 = loadJson(path.join(dir, "cf-r2.json"));
  const zones = loadJson(path.join(dir, "cf-zones.json"));
  const fly = loadJson(path.join(dir, "fly-apps.json"));
  const vercel = loadJson(path.join(dir, "vercel-projects.json"));
  return {
    "GitHub repos": Array.isArray(gh) ? gh.length : 0,
    "Cloudflare zones": zones?.result?.length ?? 0,
    "Workers": workers?.result?.length ?? 0,
    "Pages projects": pages?.result?.length ?? 0,
    "KV namespaces": kv?.result?.length ?? 0,
    "D1 databases": d1?.result?.length ?? 0,
    "R2 buckets": r2?.result?.buckets?.length ?? 0,
    "Fly apps": Array.isArray(fly) ? fly.length : 0,
    "Vercel projects": vercel?.projects?.length ?? 0,
  };
}

/** Reads the two most recent ~/Backups/xpf/<date>/inventory/ snapshots (if present)
 * to show current infra counts plus week-over-week drift. Entirely optional —
 * the dashboard still builds fine with zero backups on disk. */
export function loadInfraSnapshot(backupsRoot: string): InfraSnapshot {
  if (!existsSync(backupsRoot)) return { date: null, counts: {}, zones: [], workers: [], delta: null };
  const dates = readdirSync(backupsRoot).filter(d => /^\d{8}$/.test(d)).sort();
  if (dates.length === 0) return { date: null, counts: {}, zones: [], workers: [], delta: null };
  const latest = dates[dates.length - 1];
  const invDir = path.join(backupsRoot, latest, "inventory");
  const counts = countsFor(invDir);
  const zonesJson = loadJson(path.join(invDir, "cf-zones.json"));
  const zones = (zonesJson?.result ?? []).map((z: any) => z.name);
  const workersJson = loadJson(path.join(invDir, "cf-workers.json"));
  const workers = (workersJson?.result ?? []).map((w: any) => ({ id: w.id }));

  let delta: Record<string, number> | null = null;
  if (dates.length >= 2) {
    const prevDir = path.join(backupsRoot, dates[dates.length - 2], "inventory");
    const prevCounts = countsFor(prevDir);
    delta = {};
    for (const k of Object.keys(counts)) delta[k] = counts[k] - (prevCounts[k] ?? 0);
  }
  return { date: latest, counts, zones, workers, delta };
}
