import type { XpfConfig } from "@xpf/core/edge";

/**
 * Public URL path of an item, for the post-deploy check. The item directory is where the page really is:
 * a research item that lives under deepdive/ (abap-bench) is served at /deepdive/<slug>/, and /research/<slug>/
 * answers with the homepage. Falls back to the vertical's prefix when the plan has no directory.
 */
export function urlPathFor(config: XpfConfig, ref: string, itemDir: string | null): string | null {
  const i = ref.indexOf("/");
  const type = ref.slice(0, i), slug = ref.slice(i + 1);
  const v = config.verticals[type];
  if (!v || !v.url_prefix.startsWith("/")) return null;       // federated sites (roam) are verified elsewhere
  if (itemDir) return `/${itemDir.replace(/^\/+|\/+$/g, "")}/`;
  return `${v.url_prefix}${slug}/`;
}
