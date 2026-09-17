/** RFC 7636 PKCE helpers, plus a random `state` for CSRF protection on the OAuth redirect. */

function randomBytesBase64Url(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePkce() {
  const verifier = randomBytesBase64Url(32);        // 43-128 char url-safe string per spec
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  const state = randomBytesBase64Url(16);
  const nonce = randomBytesBase64Url(16);
  return { verifier, challenge, state, nonce };
}
