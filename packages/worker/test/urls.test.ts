import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { urlPathFor } from "../src/urls.ts";
import type { XpfConfig } from "@xpf/core/edge";

const config = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../config/verticals.json"), "utf8")) as XpfConfig;

describe("urlPathFor", () => {
  it("uses the directory the item really lives in", () => {
    expect(urlPathFor(config, "research/abap-bench", "deepdive/abap-bench")).toBe("/deepdive/abap-bench/");   // /research/abap-bench/ answers with the homepage
    expect(urlPathFor(config, "skills/some-skill", "apps/skills/some-skill")).toBe("/apps/skills/some-skill/");
    expect(urlPathFor(config, "buzzwords/109", "buzzwords/109")).toBe("/buzzwords/109/");
    expect(urlPathFor(config, "howto/skill-state", "howto/skill-state")).toBe("/howto/skill-state/");
  });
  it("falls back to the vertical prefix when the plan has no directory", () => {
    expect(urlPathFor(config, "howto/x", null)).toBe("/howto/x/");
  });
  it("returns null for federated sites and unknown types", () => {
    expect(urlPathFor(config, "roam/x", null)).toBeNull();
    expect(urlPathFor(config, "nope/x", null)).toBeNull();
  });
});
