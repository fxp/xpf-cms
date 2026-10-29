import { describe, it, expect, vi, afterEach } from "vitest";
import { GithubClient } from "../src/github.ts";

afterEach(() => vi.unstubAllGlobals());

describe("GithubClient default fetch", () => {
  it("does not call the global fetch with the client as `this` (Workers throws Illegal invocation)", async () => {
    const calls: string[] = [];
    // Mimic the Workers runtime: global fetch only works when called without a foreign receiver.
    vi.stubGlobal("fetch", function (this: unknown, input: string | URL | Request) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      calls.push(String(input));
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    const gh = new GithubClient("t", "fxp/xiaopingfeng-site");
    await gh.getText("config/site-manifest.json", "main");
    expect(calls).toEqual(["https://api.github.com/repos/fxp/xiaopingfeng-site/contents/config/site-manifest.json?ref=main"]);
  });
});
