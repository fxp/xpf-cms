// Commit signing. The CI gate has to tell "committed by the cms Worker" from "pushed by hand" without
// branch protection (the repo is private on the free plan) and without relying on the pusher identity
// (the Worker commits with a PAT today, a GitHub App later). So every Worker commit carries
//   Xpf-Sig: HMAC-SHA256(secret, "xpf-cms:v1\n<tree>\n<parent>\n<artifact>")
// which the gate recomputes from the commit itself. Forging it needs the secret.
const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export const sigPayload = (tree: string, parent: string, artifact: string) => `xpf-cms:v1\n${tree}\n${parent}\n${artifact}`;
export const signCommit = (secret: string, tree: string, parent: string, artifact: string) => hmacHex(secret, sigPayload(tree, parent, artifact));

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
