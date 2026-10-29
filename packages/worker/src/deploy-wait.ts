// "Has my commit been deployed?" A publish commit is not deployed by the push that created it: the cms Worker
// marks it "Derive: pending", derive.yml regenerates the derived files in a follow-up commit, and deploy.yml then
// runs on that (workflow_run), so the deploying run's head_sha is a DESCENDANT of the commit, not the commit.
import type { GithubLike, WorkflowRun } from "./github.ts";

export type DeployVerdict = "success" | "pending" | "failure";

const SETTLED_BAD = new Set(["failure", "timed_out", "startup_failure"]);

export async function deployVerdict(gh: Pick<GithubLike, "listRecentRuns" | "isAtOrAhead">, workflowFile: string, branch: string, commitSha: string): Promise<{ verdict: DeployVerdict; run?: WorkflowRun }> {
  const runs = await gh.listRecentRuns(workflowFile, branch);
  const covering: WorkflowRun[] = [];
  for (const r of runs) if (await gh.isAtOrAhead(commitSha, r.head_sha)) covering.push(r);
  const ok = covering.find(r => r.status === "completed" && r.conclusion === "success");
  if (ok) return { verdict: "success", run: ok };
  if (covering.some(r => r.status !== "completed")) return { verdict: "pending" };
  const bad = covering.find(r => r.status === "completed" && r.conclusion !== null && SETTLED_BAD.has(r.conclusion));
  if (bad) return { verdict: "failure", run: bad };
  return { verdict: "pending" };   // none yet, or only skipped/cancelled runs (the push-triggered deploy of a pending commit is skipped)
}
