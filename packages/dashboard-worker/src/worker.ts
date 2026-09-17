import { generatePkce } from "./pkce.ts";
import { buildAuthorizeUrl, buildLogoutUrl, exchangeCode, verifyIdToken, type Auth0Config } from "./auth0.ts";
import { parseCookies, serializeCookie, clearCookie } from "./cookies.ts";
import { signSession, verifySession } from "./session.ts";

export interface Env {
  ASSETS: Fetcher;
  AUTH0_DOMAIN: string;
  AUTH0_CLIENT_ID: string;
  AUTH0_CLIENT_SECRET?: string;
  ALLOWED_EMAILS: string;
  SESSION_SECRET: string;
}

const SESSION_COOKIE = "xpf_session";
const PKCE_COOKIE = "xpf_pkce";       // short-lived: holds {verifier,state,nonce} between /login and /callback
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

function auth0Config(env: Env, origin: string): Auth0Config {
  return {
    domain: env.AUTH0_DOMAIN,
    clientId: env.AUTH0_CLIENT_ID,
    clientSecret: env.AUTH0_CLIENT_SECRET,
    redirectUri: `${origin}/callback`,
  };
}

function isAllowed(email: string, env: Env): boolean {
  const list = env.ALLOWED_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const cookies = parseCookies(request.headers.get("cookie"));

    if (url.pathname === "/login") {
      const { verifier, challenge, state, nonce } = await generatePkce();
      const authorizeUrl = buildAuthorizeUrl(auth0Config(env, origin), { state, nonce, challenge });
      const pkceCookie = JSON.stringify({ verifier, state, nonce, returnTo: url.searchParams.get("returnTo") ?? "/" });
      return new Response(null, {
        status: 302,
        headers: {
          Location: authorizeUrl,
          "Set-Cookie": serializeCookie(PKCE_COOKIE, pkceCookie, { maxAge: 600 }),
        },
      });
    }

    if (url.pathname === "/callback") {
      const error = url.searchParams.get("error");
      if (error) return html(`<p>Auth0 登录失败：${error} — ${url.searchParams.get("error_description") ?? ""}</p><p><a href="/login">重试</a></p>`, 401);

      const raw = cookies[PKCE_COOKIE];
      if (!raw) return html(`<p>登录会话已过期或 cookie 丢失，请重新登录。</p><p><a href="/login">重新登录</a></p>`, 400);
      let pkce: { verifier: string; state: string; nonce: string; returnTo: string };
      try { pkce = JSON.parse(raw); } catch { return html("<p>登录状态解析失败。</p>", 400); }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state || state !== pkce.state) return html(`<p>state 不匹配，可能的 CSRF 或过期链接。</p><p><a href="/login">重新登录</a></p>`, 400);

      const cfg = auth0Config(env, origin);
      const exchanged = await exchangeCode(cfg, code, pkce.verifier);
      if (!exchanged.ok) {
        const hint = exchanged.error.error === "unauthorized_client" || exchanged.error.error === "invalid_client"
          ? " 这通常意味着 Auth0 应用被配置成了需要 client secret 的 Regular Web Application —— 要么在 Auth0 后台把该应用改成 Single Page Application / Token Endpoint Authentication Method = None，要么把 client secret 配成 Worker secret AUTH0_CLIENT_SECRET。"
          : "";
        return html(`<p>换取 token 失败：${exchanged.error.error} — ${exchanged.error.error_description ?? ""}</p><p>${hint}</p>`, 401);
      }

      const verified = await verifyIdToken(cfg, exchanged.idToken, pkce.nonce);
      if (!verified.ok) return html(`<p>ID token 校验失败：${verified.reason}</p>`, 401);

      if (!isAllowed(verified.claims.email, env)) {
        return html(`<p>登录成功，但 ${verified.claims.email} 不在允许名单里。</p>`, 403);
      }

      const session = await signSession(
        { email: verified.claims.email, sub: verified.claims.sub, name: verified.claims.name, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
        env.SESSION_SECRET
      );
      return new Response(null, {
        status: 302,
        headers: {
          Location: pkce.returnTo || "/",
          "Set-Cookie": [serializeCookie(SESSION_COOKIE, session, { maxAge: SESSION_TTL_SECONDS }), clearCookie(PKCE_COOKIE)].join(", "),
        },
      });
    }

    if (url.pathname === "/logout") {
      const logoutUrl = buildLogoutUrl(auth0Config(env, origin), origin);
      return new Response(null, { status: 302, headers: { Location: logoutUrl, "Set-Cookie": clearCookie(SESSION_COOKIE) } });
    }

    // everything else: require a valid session, then fall through to static assets
    const session = await verifySession(cookies[SESSION_COOKIE], env.SESSION_SECRET);
    if (!session) {
      return new Response(null, { status: 302, headers: { Location: `/login?returnTo=${encodeURIComponent(url.pathname + url.search)}` } });
    }
    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    headers.set("x-robots-tag", "noindex, nofollow");
    return new Response(assetResponse.body, { status: assetResponse.status, headers });
  },
};
