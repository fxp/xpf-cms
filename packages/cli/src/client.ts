import { readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClientConfig { api: string; token: string | null; }

/** API URL: $XPF_API_URL | ~/.config/xpf/config.json {api} | default. Token: $XPF_API_TOKEN | ~/.config/xpf/token. */
export function loadClientConfig(): ClientConfig {
  const dir = path.join(os.homedir(), ".config/xpf");
  let api = process.env.XPF_API_URL ?? "";
  if (!api) { try { api = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8")).api ?? ""; } catch { /* default below */ } }
  let token = process.env.XPF_API_TOKEN ?? null;
  const tf = path.join(dir, "token");
  if (!token && existsSync(tf)) token = readFileSync(tf, "utf8").trim() || null;
  return { api: (api || "https://cms-api.xiaopingfeng.com").replace(/\/$/, ""), token };
}

export async function postJson(cfg: ClientConfig, route: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${cfg.api}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", "user-agent": "xpf-cli" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
  return { status: r.status, json };
}
