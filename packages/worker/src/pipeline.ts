// Post-commit pipeline (Cloudflare Workflow): wait for the production deploy of the commit, verify the
// page is live, then index it. The commit itself is already on the branch by the time this starts —
// this only confirms and records. No auto-revert on failure: it is marked failed and surfaced instead.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { GithubClient } from "./github.ts";
import { setPublishStatus, upsertItem } from "./db.ts";
import type { Env, PublishParams } from "./env.ts";

const POLL_SECONDS = 30;
const MAX_POLLS = 30;           // 15 minutes

export class PublishPipeline extends WorkflowEntrypoint<Env, PublishParams> {
  async run(event: WorkflowEvent<PublishParams>, step: WorkflowStep) {
    const p = event.payload;
    const id = event.instanceId;
    try {
      if (p.wait_deploy) {
        await step.do("status:deploying", () => setPublishStatus(this.env, id, "deploying"));
        const gh = new GithubClient(this.env.GITHUB_TOKEN, this.env.GITHUB_REPO);
        let deployed: "success" | "failure" | "pending" = "pending";
        for (let i = 0; i < MAX_POLLS && deployed === "pending"; i++) {
          deployed = await step.do(`poll deploy #${i}`, async () => {
            const runs = await gh.listWorkflowRuns("deploy.yml", p.commit_sha);
            const run = runs.find(r => r.head_sha === p.commit_sha);
            if (!run || run.status !== "completed") return "pending" as const;
            return run.conclusion === "success" ? "success" as const : "failure" as const;
          });
          if (deployed === "pending") await step.sleep(`wait #${i}`, `${POLL_SECONDS} seconds`);
        }
        if (deployed !== "success") throw new Error(deployed === "failure" ? "deploy.yml failed for this commit" : "timed out waiting for deploy.yml");
      }

      if (p.url_path && p.verb !== "remove") {
        await step.do("status:verifying", () => setPublishStatus(this.env, id, "verifying"));
        await step.do("verify live", { retries: { limit: 5, delay: "20 seconds", backoff: "constant" } }, async () => {
          const url = `${this.env.SITE_BASE}${p.url_path}?xpf=${p.commit_sha.slice(0, 8)}`;
          const r = await fetch(url, { headers: { "user-agent": "xpf-cms-verify" }, redirect: "follow" });
          if (r.status !== 200) throw new Error(`${url} → ${r.status}`);
          return r.status;
        });
      }

      await step.do("index", async () => {
        const [type, ...rest] = p.ref.split("/");
        await upsertItem(this.env, { ref: p.ref, type, slug: rest.join("/"), id: p.id, title: p.title, state: p.verb === "remove" ? "removed" : "published", url_path: p.url_path, last_commit: p.commit_sha });
      });
      await step.do("status:done", () => setPublishStatus(this.env, id, "done"));
    } catch (e: any) {
      await step.do("status:failed", () => setPublishStatus(this.env, id, "failed", String(e?.message ?? e).slice(0, 500)));
      throw e;
    }
  }
}
