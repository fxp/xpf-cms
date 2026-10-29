import { describe, it, expect } from "vitest";
import { isHomepageFallback, verifyLive } from "../src/verify.ts";

const BASE = "https://xiaopingfeng.com";
const SHA = "c9e93097792f6b6028888a56b1c297dbae4c3904";
const home = `<!doctype html><html><head><title>小平的IO · AI研究者、工具构建者</title></head><body>home</body></html>`;
const page = (t: string) => `<!doctype html><html><head><title>${t}</title></head><body>${t}</body></html>`;

/** fake site: path → [status, body] ; unknown paths get the homepage with 200, like the real site */
function site(pages: Record<string, [number, string]>, redirects: Record<string, string> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const target = redirects[u.pathname];
    if (target) { const r = new Response(page("external"), { status: 200 }); Object.defineProperty(r, "url", { value: target }); return r; }
    const [status, body] = pages[u.pathname] ?? (u.pathname === "/" ? [200, home] : [200, home]);
    return new Response(body, { status });
  }) as typeof fetch;
}

describe("isHomepageFallback", () => {
  it("flags the homepage and a page with the same <title>", () => {
    expect(isHomepageFallback(home, home)).toBe(true);
    expect(isHomepageFallback(home.replace("home", "different body"), home)).toBe(true);
  });
  it("lets a real page through", () => expect(isHomepageFallback(page("SKILL.state"), home)).toBe(false));
});

describe("verifyLive", () => {
  it("passes for a deployed page", async () => {
    await expect(verifyLive(BASE, "/howto/skill-state/", SHA, site({ "/howto/skill-state/": [200, page("SKILL.state · HowTo")] }))).resolves.toBeUndefined();
  });
  it("fails when the path is not deployed and the site answers 200 with the homepage", async () => {
    await expect(verifyLive(BASE, "/howto/zz-smoke-test/", SHA, site({}))).rejects.toThrow(/homepage/);
  });
  it("fails on a non-200", async () => {
    await expect(verifyLive(BASE, "/howto/x/", SHA, site({ "/howto/x/": [500, "boom"] }))).rejects.toThrow(/500/);
  });
  it("accepts an intentional redirect to another origin (apps that hand off to their own service)", async () => {
    await expect(verifyLive(BASE, "/apps/tool/", SHA, site({}, { "/apps/tool/": "https://tool.example.dev/" }))).resolves.toBeUndefined();
  });
  it("does not call the global fetch with a foreign `this` by default (Workers: Illegal invocation)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = function (this: unknown, input: string | URL | Request) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(String(input).includes("/howto/a/") ? page("A") : home, { status: 200 }));
    } as typeof fetch;
    try { await expect(verifyLive(BASE, "/howto/a/", SHA)).resolves.toBeUndefined(); } finally { globalThis.fetch = orig; }
  });
});
