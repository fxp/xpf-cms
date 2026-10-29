export interface PublishParams {
  ref: string;
  verb: "add" | "update" | "remove";
  branch: string;
  commit_sha: string;
  actor: string;
  /** public URL path to verify once deployed (e.g. /howto/foo/); null = nothing to verify */
  url_path: string | null;
  /** true when the commit is on the default (deployed) branch. Only then does the pipeline wait for the
   *  deploy, verify the live page and write the production D1 index; sandbox branches like xpf-smoke skip all three. */
  production: boolean;
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
