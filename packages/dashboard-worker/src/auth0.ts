import { jwtVerify, createRemoteJWKSet } from "jose";

export interface Auth0Config { domain: string; clientId: string; clientSecret?: string; redirectUri: string; }

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(domain: string) {
  if (!jwks) jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
  return jwks;
}

export function buildAuthorizeUrl(cfg: Auth0Config, opts: { state: string; nonce: string; challenge: string }): string {
  const u = new URL(`https://${cfg.domain}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("state", opts.state);
  u.searchParams.set("nonce", opts.nonce);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export function buildLogoutUrl(cfg: Auth0Config, returnTo: string): string {
  const u = new URL(`https://${cfg.domain}/v2/logout`);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("returnTo", returnTo);
  return u.toString();
}

export interface TokenExchangeError { error: string; error_description?: string; }

/** Exchanges an authorization code for tokens. Tries the public-client (PKCE-only,
 * no secret) shape first, since we were only handed a Client ID. If the Auth0
 * application is configured as a confidential "Regular Web Application" instead
 * of "Single Page Application", set AUTH0_CLIENT_SECRET and it's included too —
 * either shape works against the same endpoint. */
export async function exchangeCode(cfg: Auth0Config, code: string, verifier: string): Promise<
  { ok: true; idToken: string; accessToken: string } | { ok: false; error: TokenExchangeError }
> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  };
  if (cfg.clientSecret) body.client_secret = cfg.clientSecret;

  const res = await fetch(`https://${cfg.domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  if (!res.ok) return { ok: false, error: { error: json.error ?? String(res.status), error_description: json.error_description } };
  return { ok: true, idToken: json.id_token, accessToken: json.access_token };
}

export interface VerifiedIdToken { sub: string; email: string; name?: string; email_verified?: boolean; }

export async function verifyIdToken(cfg: Auth0Config, idToken: string, expectedNonce: string): Promise<
  { ok: true; claims: VerifiedIdToken } | { ok: false; reason: string }
> {
  try {
    const { payload } = await jwtVerify(idToken, getJwks(cfg.domain), {
      issuer: `https://${cfg.domain}/`,
      audience: cfg.clientId,
    });
    if (payload.nonce !== expectedNonce) return { ok: false, reason: "nonce mismatch" };
    if (!payload.email || typeof payload.email !== "string") return { ok: false, reason: "no email claim on ID token" };
    return { ok: true, claims: { sub: String(payload.sub), email: payload.email, name: typeof payload.name === "string" ? payload.name : undefined, email_verified: !!payload.email_verified } };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? String(e) };
  }
}
