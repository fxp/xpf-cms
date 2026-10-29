import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { registerEntry } from "../src/register.ts";
import type { XpfConfig } from "../src/config-types.ts";

const config = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../config/verticals.json"), "utf8")) as XpfConfig;
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
  it("landscape and live get an id-less row in the shape the existing rows have", () => {
    const r = registerEntry({ counters: { howto: 3 }, items: [] }, config, "live/new-page", { title: "New page", date: "2026-10-29" });
    expect(r.id).toBeNull();
    expect(r.registry.items).toEqual([{ type: "live", slug: "new-page", date: "2026-10-29", title: "New page" }]);
    expect(r.registry.counters).toEqual({ howto: 3 });
    const gone = registerEntry(r.registry, config, "live/new-page", { title: "", date: "2026-11-01", remove: true });
    expect(gone.registry.items[0]).toMatchObject({ status: "removed", removed_date: "2026-11-01" });
    expect(() => registerEntry(r.registry, config, "live/new-page", { title: "x", date: "2026-10-29" })).toThrow(/already registered/);
  });
  it("rejects types that are not id-tracked or not hosted here, and bad dates", () => {
    expect(() => registerEntry(reg(), config, "training/x", { title: "x", date: "2026-10-29" })).toThrow(/not id-tracked/);
    expect(() => registerEntry(reg(), config, "roam/x", { title: "x", date: "2026-10-29" })).toThrow(/own repo/);
    expect(() => registerEntry(reg(), config, "howto/y", { title: "y", date: "10/29/2026" })).toThrow(/YYYY-MM-DD/);
  });
});
