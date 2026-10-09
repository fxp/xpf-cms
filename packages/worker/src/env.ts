export interface PublishParams {
  ref: string;
  verb: "add" | "update" | "remove";
  branch: string;
  commit_sha: string;
  actor: string;
  /** public URL path to verify once deployed (e.g. /howto/foo/); null = nothing to verify */
  url_path: string | null;
  /** whether to wait for the production deploy of commit_sha (main only) */
  wait_deploy: boolean;
  id: string | null;
  title: string | null;
}

export interface Env {
  DB: D1Database;
  MANIFEST: KVNamespace;
  PUBLISH: Workflow<PublishParams>;
  /** secrets */
  GITHUB_TOKEN: string;
  XPF_API_TOKEN: string;
  XPF_SIGNING_SECRET: string;
  /** vars */
  GITHUB_REPO: string;          // "fxp/xiaopingfeng-site"
  ALLOWED_BRANCHES: string;     // "main,xpf-smoke"  (first = default)
  SITE_BASE: string;            // "https://xiaopingfeng.com"
}
