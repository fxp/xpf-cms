import { describe, it, expect } from "vitest";
import { checkAccess, esc } from "../src/access.ts";
import worker, { type Env } from "../src/worker.ts";

const LIST = "fxp007@gmail.com";

describe("checkAccess", () => {
  it("lets in a listed, verified email (any case, any spacing in the list)", () => {
    expect(checkAccess({ email: "fxp007@gmail.com", email_verified: true }, LIST)).toEqual({ ok: true });
    expect(checkAccess({ email: "FXP007@Gmail.com", email_verified: true }, " a@b.com , fxp007@gmail.com ")).toEqual({ ok: true });
  });
  it("refuses a listed email that is not verified: a password sign-up with someone else's address", () => {
    expect(checkAccess({ email: "fxp007@gmail.com", email_verified: false }, LIST)).toEqual({ ok: false, status: 403, reason: "unverified" });
    expect(checkAccess({ email: "fxp007@gmail.com" }, LIST)).toEqual({ ok: false, status: 403, reason: "unverified" });       // claim missing
  });
  it("only a strict true counts as verified (not a string or a number)", () => {
    expect(checkAccess({ email: "fxp007@gmail.com", email_verified: "true" as any }, LIST).ok).toBe(false);
    expect(checkAccess({ email: "fxp007@gmail.com", email_verified: 1 as any }, LIST).ok).toBe(false);
  });
  it("refuses anyone not on the list, verified or not, and an empty list lets nobody in", () => {
    expect(checkAccess({ email: "other@example.com", email_verified: true }, LIST)).toEqual({ ok: false, status: 403, reason: "not_allowed" });
    expect(checkAccess({ email: "fxp007@gmail.com", email_verified: true }, "")).toEqual({ ok: false, status: 403, reason: "not_allowed" });
    expect(checkAccess({ email: "", email_verified: true }, ",,")).toEqual({ ok: false, status: 403, reason: "not_allowed" });
  });
  it("does not match on a prefix, suffix or lookalike of a listed address", () => {
    for (const e of ["xfxp007@gmail.com", "fxp007@gmail.com.evil.io", "fxp007@gmail.co", "fxp007+x@gmail.com"]) expect(checkAccess({ email: e, email_verified: true }, LIST).ok).toBe(false);
  });
});

describe("esc", () => {
  it("escapes the five HTML metacharacters and tolerates null", () => {
    expect(esc(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
    expect(esc(null)).toBe("");
  });
});

describe("/callback never reflects request text as HTML", () => {
  const env = { ASSETS: { fetch: async () => new Response("") }, AUTH0_DOMAIN: "x.auth0.com", AUTH0_CLIENT_ID: "id", ALLOWED_EMAILS: LIST, SESSION_SECRET: "s" } as unknown as Env;
  it("error and error_description from the query string are escaped", async () => {
    const r = await worker.fetch(new Request(`https://cms.example/callback?error=${encodeURIComponent("<script>alert(1)</script>")}&error_description=${encodeURIComponent('"><img src=x onerror=alert(2)>')}`), env);
    const body = await r.text();
    expect(r.status).toBe(401);
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;script&gt;");
  });
});
