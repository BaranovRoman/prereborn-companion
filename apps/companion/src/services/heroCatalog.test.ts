import { describe, expect, it } from "vitest";
import { DOTA_HEROES, getHeroAttribute, getHeroById, getHeroByInternalName, searchHeroes } from "./heroCatalog";

describe("heroCatalog - searchHeroes", () => {
  it("returns every hero for an empty query", () => {
    expect(searchHeroes("")).toHaveLength(DOTA_HEROES.length);
    expect(searchHeroes("   ")).toHaveLength(DOTA_HEROES.length);
  });

  it("matches localized (EN) name, case-insensitively and by substring", () => {
    const results = searchHeroes("pudge");
    expect(results.map((h) => h.name)).toContain("pudge");
    expect(searchHeroes("PUDGE").map((h) => h.name)).toContain("pudge");
    expect(searchHeroes("dg").map((h) => h.name)).toContain("pudge");
  });

  it("matches internal (engine) name", () => {
    expect(searchHeroes("crystal_maiden").map((h) => h.name)).toContain("crystal_maiden");
  });

  it("matches RU/CIS aliases", () => {
    expect(searchHeroes("пудж").map((h) => h.name)).toContain("pudge");
    expect(searchHeroes("сф").map((h) => h.name)).toContain("nevermore");
    expect(searchHeroes("кв").map((h) => h.name)).toContain("queenofpain");
  });

  it("returns no results for a query matching nothing", () => {
    expect(searchHeroes("zzzznotahero")).toHaveLength(0);
  });
});

describe("heroCatalog - lookups", () => {
  it("getHeroById / getHeroByInternalName resolve the same hero from either key", () => {
    const byId = getHeroById(14);
    const byName = getHeroByInternalName("pudge");
    expect(byId?.name).toBe("pudge");
    expect(byName?.id).toBe(14);
  });

  it("every hero carries a video URL paired with a portrait fallback", () => {
    for (const hero of DOTA_HEROES) {
      expect(hero.videoUrl).toMatch(/^https:\/\//);
      expect(hero.portraitUrl).toMatch(/^https:\/\//);
    }
  });

  it("getHeroAttribute groups known heroes correctly and defaults unknowns to universal", () => {
    expect(getHeroAttribute(14)).toBe("strength"); // Pudge
    expect(getHeroAttribute(1)).toBe("agility"); // Anti-Mage
    expect(getHeroAttribute(74)).toBe("intelligence"); // Invoker
    expect(getHeroAttribute(999999)).toBe("universal");
  });
});
