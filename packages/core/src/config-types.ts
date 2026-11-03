// Pure types: no node imports, safe for the Worker bundle.
export interface VerticalConfig {
  label: string;
  dirs: string[];
  url_prefix: string;
  id_prefix: string;
  counter: string | null;
  /** counter is null but items still have id-less entries in the registry (landscape, live): `xpf register` adds them and a publish carries the registry. */
  registered?: boolean;
  /** a generated tree published as one unit (graph/): no per-item meta, registry or listing; every file under `dirs` belongs to the
   *  publish, which is always an `update` of <type>/<name> (the name only labels the commit). */
  tree?: boolean;
  body_format?: string;
  markdown_source?: "derived" | "authored" | "none";
  in_manifest?: boolean;
  own_llms?: boolean;
  indexed?: boolean;
  source?: string;
  federated?: boolean;
  manifest_url?: string;
  description?: string;
  /** Hand-maintained listing/aggregate files this vertical's publishes edit (source files, sent with the commit). */
  listing?: string[];
}
export interface PublishConfig {
  /** Content-id registry, edited by every publish (counter + items). */
  registry: string;
  /** CI-generated paths outside item dirs; never part of a publish bundle. Globs: `**` any depth, `*` one segment. */
  derived: string[];
  /** Paths a publish may never touch, not even via --also. */
  forbidden: string[];
}
export interface SiteConfig {
  name: string; base_url: string; author: string; author_handle: string;
  default_language: string; description: string;
}
export interface XpfConfig { site: SiteConfig; publish: PublishConfig; verticals: Record<string, VerticalConfig>; }
