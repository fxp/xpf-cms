import { Hono } from "hono";
import { z } from "zod";
import type { XpfConfig } from "@xpf/core/edge";
import verticals from "../../../config/verticals.json";
import { GithubClient } from "./github.ts";
import { publish, summarize, HttpError, type PublishRequest } from "./service.ts";
import { audit, recordPublish } from "./db.ts";
import { timingSafeEqual } from "./sign.ts";
import type { Env, PublishParams } from "./env.ts";

export { PublishPipeline } from "./pipeline.ts";

const config = verticals as unknown as XpfConfig;
const MAX_BODY = 90 * 1024 * 1024;

const Change = z.object({
  path: z.string().min(1).max(500),
  op: z.enum(["put", "delete"]),
  encoding: z.enum(["utf8", "base64"]).optional(),
  content: z.string().optional(),
  size: z.number().optional(),
});
const PublishBody = z.object({
  ref: z.string().min(3).max(300),
  verb: z.enum(["add", "update", "remove"]),
  intent: z.object({
    summary: z.string().max(4000), actor: z.string().max(100), calendar: z.boolean(), also: z.array(z.string()).max(50),
    itemDir: z.string().max(300), placeholder: z.boolean(), derive: z.boolean(),
  }).partial().optional(),
  bundle: z.object({ base_sha: z.string().optional(), changes: z.array(Change).max(1000) }),
  branch: z.string().max(100).optional(),
  dry_run: z.boolean().optional(),
});

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", c => c.json({ ok: true, service: "xpf-cms", repo: c.env.GITHUB_REPO, branches: c.env.ALLOWED_BRANCHES }));

// everything under /api needs the service token
app.use("/api/*", async (c, next) => {
  const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
  if (!c.env.XPF_API_TOKEN || !m || !timingSafeEqual(m[1], c.env.XPF_API_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

function urlPathFor(ref: string): string | null {
  const i = ref.indexOf("/");
  const type = ref.slice(0, i), slug = ref.slice(i + 1);
  const v = config.verticals[type];
  if (!v || !v.url_prefix.startsWith("/")) return null;
  return `${v.url_prefix}${slug}/`;
}

app.post("/api/publish", async c => {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > MAX_BODY) return c.json({ error: "bundle too large" }, 413);
  let body: z.infer<typeof PublishBody>;
  try { body = PublishBody.parse(await c.req.json()); } catch (e: any) { return c.json({ error: "bad request", detail: String(e?.message ?? e).slice(0, 600) }, 400); }

  const allowed = c.env.ALLOWED_BRANCHES.split(",").map(s => s.trim()).filter(Boolean);
  const gh = new GithubClient(c.env.GITHUB_TOKEN, c.env.GITHUB_REPO);
  const actor = body.intent?.actor ?? "human";
  const log = (status: string, extra: { commit_sha?: string; detail?: string; branch?: string } = {}) =>
    c.executionCtx.waitUntil(body.dry_run ? Promise.resolve() : audit(c.env, { actor, verb: body.verb, ref: body.ref, status, ...extra }).catch(() => {}));

  try {
    const res = await publish({ gh, config, signingSecret: c.env.XPF_SIGNING_SECRET, allowedBranches: allowed }, body as PublishRequest);
    if (res.status === "dry_run" || res.status === "rejected") {
      if (res.status === "rejected") log("rejected", { branch: res.branch, detail: res.plan.findings.filter(f => f.severity === "error").map(f => f.code).join(",") });
      return c.json({ status: res.status, branch: res.branch, head: res.head, plan: summarize(res.plan), commit_message: res.plan.commit.message }, res.status === "rejected" ? 422 : 200);
    }
    if (res.status === "conflict") { log("conflict", { branch: res.branch, detail: res.conflicts.join(",") }); return c.json({ status: "conflict", conflicts: res.conflicts, head: res.head, message: res.message }, 409); }

    // committed: kick off the post-commit pipeline and record the audit row
    const urlPath = urlPathFor(body.ref);
    const params: PublishParams = {
      ref: body.ref, verb: body.verb, branch: res.branch, commit_sha: res.commit_sha, actor, url_path: urlPath,
      wait_deploy: res.branch === allowed[0], id: res.plan.id, title: null,
    };
    let instanceId: string | null = null;
    try {
      const inst = await c.env.PUBLISH.create({ params });
      instanceId = inst.id;
      await recordPublish(c.env, { instance_id: inst.id, ref: body.ref, verb: body.verb, branch: res.branch, commit_sha: res.commit_sha, status: "queued" });
    } catch (e: any) { log("error", { commit_sha: res.commit_sha, branch: res.branch, detail: `workflow start failed: ${e?.message}` }); }
    log("committed", { commit_sha: res.commit_sha, branch: res.branch });
    return c.json({
      status: "committed", branch: res.branch, commit_sha: res.commit_sha, parent: res.parent, instance_id: instanceId,
      commit_url: `https://github.com/${c.env.GITHUB_REPO}/commit/${res.commit_sha}`, plan: summarize(res.plan),
    }, 201);
  } catch (e: any) {
    if (e instanceof HttpError) { log("rejected", { detail: e.message }); return c.json({ error: e.message }, e.status as 400 | 403 | 409 | 500); }
    log("error", { detail: String(e?.message ?? e).slice(0, 500) });
    return c.json({ error: "publish failed", detail: String(e?.message ?? e).slice(0, 500) }, 502);
  }
});

app.get("/api/publish/:id", async c => {
  const row = await c.env.DB.prepare("select * from publishes where instance_id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.get("/api/items", async c => {
  const type = c.req.query("type");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const q = type
    ? c.env.DB.prepare("select * from items where type = ? order by coalesce(last_updated, first_published) desc limit ?").bind(type, limit)
    : c.env.DB.prepare("select * from items order by coalesce(last_updated, first_published) desc limit ?").bind(limit);
  return c.json((await q.all()).results);
});

app.get("/api/audit", async c => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 500);
  return c.json((await c.env.DB.prepare("select * from audit order by id desc limit ?").bind(limit).all()).results);
});

// Rebuild D1 `items` from the generated manifest on the default branch (Git is the truth, D1 is derived).
app.post("/api/reindex", async c => {
  const branch = c.env.ALLOWED_BRANCHES.split(",")[0].trim();
  const gh = new GithubClient(c.env.GITHUB_TOKEN, c.env.GITHUB_REPO);
  const text = await gh.getText("config/site-manifest.json", branch);
  if (!text) return c.json({ error: "site-manifest.json not found" }, 502);
  const manifest = JSON.parse(text) as { items: any[] };
  const stmts = manifest.items.map(it => c.env.DB.prepare(
    `insert into items (ref, type, slug, id, title, state, url_path, first_published, last_updated, last_commit, indexed_at) values (?,?,?,?,?,?,?,?,?,null,?)
     on conflict(ref) do update set type=excluded.type, slug=excluded.slug, id=excluded.id, title=excluded.title, state=excluded.state, url_path=excluded.url_path,
       first_published=excluded.first_published, last_updated=excluded.last_updated, indexed_at=excluded.indexed_at`)
    .bind(`${it.type}/${it.slug}`, it.type, String(it.slug), it.id ?? null, it.title ?? null, it.status ?? "published", it.url_path ?? null, it.date ?? null, it.updates?.at?.(-1)?.date ?? it.date ?? null, new Date().toISOString()));
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  await c.env.MANIFEST.put("manifest:count", String(manifest.items.length));
  return c.json({ reindexed: manifest.items.length });
});

app.notFound(c => c.json({ error: "not found" }, 404));
app.onError((e, c) => { console.error(e); return c.json({ error: "internal error" }, 500); });

export default app;
