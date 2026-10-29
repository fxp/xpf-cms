// "Is the page really live?" The site answers unknown paths with 200 and the homepage, so a bare status
// check passes for a page that never deployed. We therefore also compare the page with the homepage.

const titleOf = (html: string) => /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1].replace(/\s+/g, " ").trim() ?? null;

/** True when `page` is the site's homepage served as a fallback for a path that does not exist. */
export function isHomepageFallback(page: string, home: string): boolean {
  if (page === home) return true;
  const t = titleOf(page);
  return t !== null && t === titleOf(home);
}

/** Throws unless `${siteBase}${urlPath}` serves its own page. A redirect to another origin (apps that
 *  hand off to a separately deployed service) counts as live as long as it ends in a 200. */
export async function verifyLive(
  siteBase: string, urlPath: string, sha: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<void> {
  const get = (url: string) => fetchImpl(url, { headers: { "user-agent": "xpf-cms-verify" }, redirect: "follow" });
  const q = `?xpf=${sha.slice(0, 8)}`;
  const url = `${siteBase}${urlPath}${q}`;
  const r = await get(url);
  if (r.status !== 200) throw new Error(`${url} → ${r.status}`);
  if (new URL(r.url || url).origin !== new URL(siteBase).origin) return;
  const [page, home] = [await r.text(), await (await get(`${siteBase}/${q}`)).text()];
  if (isHomepageFallback(page, home)) throw new Error(`${url} serves the homepage, not the page (not deployed yet?)`);
}
