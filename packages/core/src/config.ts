import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface VerticalConfig {
  label: string;
  dirs: string[];
  url_prefix: string;
  id_prefix: string;
  counter: string | null;
  body_format?: string;
  markdown_source?: "derived" | "authored" | "none";
  in_manifest?: boolean;
  own_llms?: boolean;
  indexed?: boolean;
  source?: string;
  federated?: boolean;
  manifest_url?: string;
  description?: string;
}
export interface SiteConfig {
  name: string; base_url: string; author: string; author_handle: string;
  default_language: string; description: string;
}
export interface XpfConfig { site: SiteConfig; verticals: Record<string, VerticalConfig>; }

export function loadConfig(configPath?: string): XpfConfig {
  const p = configPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../config/verticals.json");
  return JSON.parse(readFileSync(p, "utf8")) as XpfConfig;
}
