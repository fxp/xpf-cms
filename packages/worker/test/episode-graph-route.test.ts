import { beforeEach, describe, expect, it, vi } from "vitest";

const { read, complete, audit, isAtOrAhead, verify } = vi.hoisted(() => ({
  read: vi.fn(), complete: vi.fn(), audit: vi.fn(), isAtOrAhead: vi.fn(), verify: vi.fn(),
}));
vi.mock("../src/pipeline.ts", () => ({ PublishPipeline: class {} }));
vi.mock("../src/db.ts", () => ({ getPublish: read, completeEpisodeGraph: complete, recordPublish: vi.fn(), audit }));
vi.mock("../src/github.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/github.ts")>()),
  GithubClient: class { isAtOrAhead = isAtOrAhead; },
}));
vi.mock("../src/episode-graph.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/episode-graph.ts")>()),
  verifyEpisodeGraph: verify,
}));

import app from "../src/index.ts";
import type { Env } from "../src/env.ts";

const episode = { instance_id: "episode", ref: "buzzwords/112", verb: "update", branch: "main", commit_sha: "episode-sha", status: "awaiting_graph" };
const graph = { instance_id: "graph", ref: "graph/site", verb: "update", branch: "main", commit_sha: "graph-sha", status: "done" };
const env = { XPF_API_TOKEN: "test-token", ALLOWED_BRANCHES: "main,xpf-smoke", SITE_BASE: "https://xiaopingfeng.com" } as Env;

function request(method: "GET" | "POST") {
  return app.request(method === "GET" ? "/api/publish/episode" : "/api/publish/episode/graph", {
    method, headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify({ graph_instance_id: "graph" }) : undefined,
  }, env, { waitUntil: vi.fn() } as unknown as ExecutionContext);
}

beforeEach(() => {
  vi.resetAllMocks();
  read.mockImplementation(async (_, id) => id === "episode" ? episode : graph);
  complete.mockResolvedValue(true);
  audit.mockResolvedValue(undefined);
  isAtOrAhead.mockResolvedValue(true);
  verify.mockResolvedValue(undefined);
});

describe("Buzzwords Graph follow-up", () => {
  it("reports the pending episode and completes it after verifying a later Graph release", async () => {
    const pending = await request("GET");
    expect(await pending.json()).toMatchObject({ status: "awaiting_graph", next_action: { type: "sync_episode_graph", episode: "112" } });
    const done = await request("POST");
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: "done", graph_instance_id: "graph" });
    expect(isAtOrAhead).toHaveBeenCalledWith("episode-sha", "graph-sha");
    expect(verify).toHaveBeenCalledWith(env.SITE_BASE, "112", "graph-sha");
    expect(complete).toHaveBeenCalledWith(env, "episode");
  });

  it("leaves the episode pending when the Graph revision is older or the public data is unavailable", async () => {
    isAtOrAhead.mockResolvedValueOnce(false);
    expect((await request("POST")).status).toBe(409);
    expect(verify).not.toHaveBeenCalled();
    verify.mockRejectedValueOnce(new Error("Graph episode not found"));
    expect((await request("POST")).status).toBe(422);
    expect(complete).not.toHaveBeenCalled();
  });
});
