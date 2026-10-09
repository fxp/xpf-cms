import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export * from "./config-types.ts";
import type { XpfConfig } from "./config-types.ts";

export function loadConfig(configPath?: string): XpfConfig {
  const p = configPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../config/verticals.json");
  return JSON.parse(readFileSync(p, "utf8")) as XpfConfig;
}
