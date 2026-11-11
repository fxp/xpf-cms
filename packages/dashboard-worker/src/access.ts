// Who gets into the dashboard after Auth0 has authenticated them.
//
// Auth0's login page lets anyone sign up with any email address, and a password account is usable before its email is
// verified (the ID token then carries email_verified=false). So matching the allow-list on the email claim alone lets
// someone register "owner@example.com" with a password they chose and walk in. The email must be on the list AND verified
// (Google and the other social providers vouch for it; a password account becomes verified through Auth0's verification mail).
export interface AccessClaims { email: string; email_verified?: boolean }
export type Access = { ok: true } | { ok: false; status: 403; reason: "not_allowed" | "unverified" };

export function checkAccess(claims: AccessClaims, allowedCsv: string): Access {
  const list = allowedCsv.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.includes(String(claims.email).trim().toLowerCase())) return { ok: false, status: 403, reason: "not_allowed" };
  if (claims.email_verified !== true) return { ok: false, status: 403, reason: "unverified" };
  return { ok: true };
}

/** Text that comes from the request or from the ID token goes into HTML pages here; escape it. */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
