import type { Env } from "./env.ts";

const now = () => new Date().toISOString();

export async function audit(env: Env, row: { actor?: string; origin?: string; verb?: string; ref?: string; branch?: string; commit_sha?: string; status: string; detail?: string }) {
  await env.DB.prepare("insert into audit (ts, actor, origin, verb, ref, branch, commit_sha, status, detail) values (?,?,?,?,?,?,?,?,?)")
    .bind(now(), row.actor ?? null, row.origin ?? "cli", row.verb ?? null, row.ref ?? null, row.branch ?? null, row.commit_sha ?? null, row.status, row.detail ?? null).run();
}

export async function recordPublish(env: Env, row: { instance_id: string; ref: string; verb: string; branch: string; commit_sha: string; status: string }) {
  const t = now();
  await env.DB.prepare("insert or replace into publishes (instance_id, ref, verb, branch, commit_sha, status, created_at, updated_at) values (?,?,?,?,?,?,?,?)")
    .bind(row.instance_id, row.ref, row.verb, row.branch, row.commit_sha, row.status, t, t).run();
}

export async function setPublishStatus(env: Env, instanceId: string, status: string, error?: string) {
  await env.DB.prepare("update publishes set status = ?, updated_at = ?, error = ? where instance_id = ?").bind(status, now(), error ?? null, instanceId).run();
}

export async function upsertItem(env: Env, it: { ref: string; type: string; slug: string; id?: string | null; title?: string | null; state?: string | null; url_path?: string | null; first_published?: string | null; last_updated?: string | null; last_commit?: string | null }) {
  await env.DB.prepare(
    `insert into items (ref, type, slug, id, title, state, url_path, first_published, last_updated, last_commit, indexed_at) values (?,?,?,?,?,?,?,?,?,?,?)
     on conflict(ref) do update set type=excluded.type, slug=excluded.slug, id=coalesce(excluded.id, items.id), title=coalesce(excluded.title, items.title), state=excluded.state,
       url_path=coalesce(excluded.url_path, items.url_path), first_published=coalesce(items.first_published, excluded.first_published), last_updated=coalesce(excluded.last_updated, items.last_updated),
       last_commit=coalesce(excluded.last_commit, items.last_commit), indexed_at=excluded.indexed_at`)
    .bind(it.ref, it.type, it.slug, it.id ?? null, it.title ?? null, it.state ?? "published", it.url_path ?? null, it.first_published ?? null, it.last_updated ?? null, it.last_commit ?? null, now()).run();
}
