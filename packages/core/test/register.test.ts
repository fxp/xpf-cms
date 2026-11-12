import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { registerEntry } from "../src/register.ts";
import type { XpfConfig } from "../src/config-types.ts";

const baseConfig = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../config/verticals.json"), "utf8")) as XpfConfig;
const config = { ...baseConfig, verticals: { ...baseConfig.verticals, live: { label: "Live", dirs: ["live"], url_prefix: "/live/", id_prefix: "LV", counter: null, registered: true } } } as XpfConfig;   // landscape/live are retired from the real config; `registered` is still supported
const reg = () => ({
  counters: { howto: 3, buzzwords: 108, deepdive: 10 },
  items: [
    { id: "0003", type: "howto", slug: "wiki-skill", date: "2026-09-10", title: "Wiki" },
    { id: "0108", type: "buzzwords", ep: 108, date: "2026-10-23", title: "EP.108" },
    { id: "0001", type: "deepdive", slug: "old", date: "2026-01-01", title: "Old", status: "removed", removed_date: "2026-02-02" },
  ],
});

describe("registerEntry", () => {
  it("allocates the next id and bumps the counter", () => {
    const r = registerEntry(reg(), config, "howto/new-thing", { title: "New thing", date: "2026-10-29" });
    expect(r.id).toBe("0004");
    expect(r.registry.counters.howto).toBe(4);
    expect(r.registry.items.at(-1)).toEqual({ id: "0004", type: "howto", slug: "new-thing", date: "2026-10-29", title: "New thing" });
  });
  it("does not mutate its input", () => {
    const input = reg(); registerEntry(input, config, "howto/x", { title: "x", date: "2026-10-29" });
    expect(input).toEqual(reg());
  });
  it("buzzwords: id is the padded episode number and the counter follows it", () => {
    const r = registerEntry(reg(), config, "buzzwords/109", { title: "EP.109", date: "2026-10-30" });
    expect(r.registry.items.at(-1)).toEqual({ id: "0109", type: "buzzwords", ep: 109, date: "2026-10-30", title: "EP.109" });
    expect(r.registry.counters.buzzwords).toBe(109);
  });
  it("refuses a slug that is already registered, or was removed", () => {
    expect(() => registerEntry(reg(), config, "howto/wiki-skill", { title: "x", date: "2026-10-29" })).toThrow(/already registered/);
    expect(() => registerEntry(reg(), config, "deepdive/old", { title: "x", date: "2026-10-29" })).toThrow(/was removed/);
  });
  it("remove writes the tombstone the validator expects", () => {
    const r = registerEntry(reg(), config, "howto/wiki-skill", { title: "", date: "2026-10-29", remove: true });
    expect(r.registry.items[0]).toMatchObject({ status: "removed", removed_date: "2026-10-29" });
    expect(r.registry.counters.howto).toBe(3);
  });
  it("remove of an unknown or already removed ref fails", () => {
    expect(() => registerEntry(reg(), config, "howto/nope", { title: "", date: "2026-10-29", remove: true })).toThrow(/not in the registry/);
    expect(() => registerEntry(reg(), config, "deepdive/old", { title: "", date: "2026-10-29", remove: true })).toThrow(/already removed/);
  });
  it("a `registered` vertical (id-less) gets a row in the shape the existing rows have", () => {
    const r = registerEntry({ counters: { howto: 3 }, items: [] }, config, "live/new-page", { title: "New page", date: "2026-10-29" });
    expect(r.id).toBeNull();
    expect(r.registry.items).toEqual([{ type: "live", slug: "new-page", date: "2026-10-29", title: "New page" }]);
    expect(r.registry.counters).toEqual({ howto: 3 });
    const gone = registerEntry(r.registry, config, "live/new-page", { title: "", date: "2026-11-01", remove: true });
    expect(gone.registry.items[0]).toMatchObject({ status: "removed", removed_date: "2026-11-01" });
    expect(() => registerEntry(r.registry, config, "live/new-page", { title: "x", date: "2026-10-29" })).toThrow(/already registered/);
  });
  it("rejects types that are not id-tracked, and bad dates", () => {
    expect(() => registerEntry(reg(), config, "training/x", { title: "x", date: "2026-10-29" })).toThrow(/not id-tracked/);
    expect(() => registerEntry(reg(), config, "howto/y", { title: "y", date: "10/29/2026" })).toThrow(/YYYY-MM-DD/);
  });
});

describe("registerEntry · federated (roam: pages in another repo, id and counter here)", () => {
  const roamReg = () => ({ counters: { roam: 11 }, items: [{ id: "0011", type: "roam", slug: "native-agent-focus-room", date: "2026-10-26", title: "x" }] });
  it("allocates the next RM id and bumps the counter", () => {
    const r = registerEntry(roamReg(), config, "roam/hardware-agent-bench", { title: "硬件 Agent 接入 Bench", date: "2026-11-11" });
    expect(r.id).toBe("0012");
    expect(r.registry.counters.roam).toBe(12);
    expect(r.registry.items.at(-1)).toEqual({ id: "0012", type: "roam", slug: "hardware-agent-bench", date: "2026-11-11", title: "硬件 Agent 接入 Bench" });
  });
  it("writes the removal tombstone, and refuses to tombstone a task that was never registered", () => {
    const r = registerEntry(roamReg(), config, "roam/native-agent-focus-room", { title: "", date: "2026-11-12", remove: true });
    expect(r.registry.items[0]).toMatchObject({ status: "removed", removed_date: "2026-11-12" });
    expect(() => registerEntry(roamReg(), config, "roam/never-registered", { title: "", date: "2026-11-12", remove: true })).toThrow(/not in the registry/);
  });
});

