// Post-commit pipeline (Cloudflare Workflow): wait for the production deploy of the commit, verify the
// page is live, then index it. The commit itself is already on the branch by the time this starts —
// this only confirms and records. No auto-revert on failure: it is marked failed and surfaced instead.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { GithubClient } from "./github.ts";
import { setPublishStatus, upsertItem } from "./db.ts";
import { verifyLive } from "./verify.ts";
import { deployVerdict, type DeployVerdict } from "./deploy-wait.ts";
import type { Env, PublishParams } from "./env.ts";

const POLL_SECONDS = 30;
const MAX_POLLS = 30;           // 15 minutes
const FAILURES_BEFORE_GIVING_UP = 3;   // a failed run can be followed by a good one (Translate and Derive both deploy)

export class PublishPipeline extends WorkflowEntrypoint<Env, PublishParams> {
  async run(event: WorkflowEvent<PublishParams>, step: WorkflowStep) {
    const p = event.payload;
    const id = event.instanceId;
    try {
      if (p.production) {
        await step.do("status:deploying", () => setPublishStatus(this.env, id, "deploying"));
        const gh = new GithubClient(this.env.GITHUB_TOKEN, this.env.GITHUB_REPO);
        let deployed: DeployVerdict = "pending", failures = 0;
        for (let i = 0; i < MAX_POLLS && deployed !== "success"; i++) {
          deployed = await step.do(`poll deploy #${i}`, async () => (await deployVerdict(gh, "deploy.yml", p.branch, p.commit_sha)).verdict);
          failures = deployed === "failure" ? failures + 1 : 0;
          if (failures >= FAILURES_BEFORE_GIVING_UP) throw new Error("deploy.yml failed for this commit");
          if (deployed !== "success") await step.sleep(`wait #${i}`, `${POLL_SECONDS} seconds`);
        }
        if (deployed !== "success") throw new Error("timed out waiting for deploy.yml");
      }

      // Sandbox branches (xpf-smoke) are never deployed, so there is nothing live to verify and nothing for the production index.
      if (p.production && p.url_path && p.verb !== "remove") {
        await step.do("status:verifying", () => setPublishStatus(this.env, id, "verifying"));
        await step.do("verify live", { retries: { limit: 5, delay: "20 seconds", backoff: "constant" } }, async () => {
          await verifyLive(this.env.SITE_BASE, p.url_path!, p.commit_sha);
          return "ok";
        });
      }

      if (p.production) {
        await step.do("index", async () => {
          const [type, ...rest] = p.ref.split("/");
          await upsertItem(this.env, { ref: p.ref, type, slug: rest.join("/"), id: p.id, title: p.title, state: p.verb === "remove" ? "removed" : "published", url_path: p.url_path, last_commit: p.commit_sha });
        });
      }
      await step.do("status:done", () => setPublishStatus(this.env, id, "done"));
    } catch (e: any) {
      await step.do("status:failed", () => setPublishStatus(this.env, id, "failed", String(e?.message ?? e).slice(0, 500)));
      throw e;
    }
  }
}
