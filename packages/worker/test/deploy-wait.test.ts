import { describe, it, expect } from "vitest";
import { deployVerdict } from "../src/deploy-wait.ts";
import type { WorkflowRun } from "../src/github.ts";

const run = (id: number, head_sha: string, status: string, conclusion: string | null, event = "workflow_run"): WorkflowRun => ({ id, head_sha, status, conclusion, html_url: "", event });
/** commits form a line: index = position; a run covers the commit when its head is at or after it */
const line = ["base", "W", "D1", "later"];
const gh = (runs: WorkflowRun[]) => ({
  listRecentRuns: async () => runs,
  isAtOrAhead: async (a: string, b: string) => line.indexOf(b) >= line.indexOf(a),
});

describe("deployVerdict (publish commit W is deployed by a later run on its descendant D1)", () => {
  it("success: the run that deployed the derive commit covers W", async () => {
    expect((await deployVerdict(gh([run(2, "D1", "completed", "success"), run(1, "base", "completed", "success", "push")]), "deploy.yml", "main", "W")).verdict).toBe("success");
  });
  it("an older successful run (before W) does not count", async () => {
    expect((await deployVerdict(gh([run(1, "base", "completed", "success", "push")]), "deploy.yml", "main", "W")).verdict).toBe("pending");
  });
  it("the push-triggered run for the pending commit is skipped, which keeps waiting for the derive deploy", async () => {
    expect((await deployVerdict(gh([run(1, "W", "completed", "skipped", "push")]), "deploy.yml", "main", "W")).verdict).toBe("pending");
  });
  it("pending while a covering run is in progress", async () => {
    expect((await deployVerdict(gh([run(2, "D1", "in_progress", null)]), "deploy.yml", "main", "W")).verdict).toBe("pending");
  });
  it("failure when the only covering run failed", async () => {
    expect((await deployVerdict(gh([run(2, "D1", "completed", "failure")]), "deploy.yml", "main", "W")).verdict).toBe("failure");
  });
  it("a later success wins over an earlier failure", async () => {
    expect((await deployVerdict(gh([run(3, "later", "completed", "success"), run(2, "D1", "completed", "failure")]), "deploy.yml", "main", "W")).verdict).toBe("success");
  });
});
