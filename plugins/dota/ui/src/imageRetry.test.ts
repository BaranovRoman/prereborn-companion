// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { retryFailedCdnImages } from "./imageRetry";
describe("CDN image retry", () => {
  it("retries a failed Steam CDN image once on the same host and leaves others alone", () => {
    retryFailedCdnImages();
    const hero = document.createElement("img"); hero.src = "https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/lion.png"; document.body.append(hero);
    hero.dispatchEvent(new Event("error"));
    expect(hero.src).toBe("https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/lion.png?r=1");
    hero.dispatchEvent(new Event("error"));
    expect(hero.src.endsWith("?r=1")).toBe(true);
    const other = document.createElement("img"); other.src = "http://127.0.0.1:3666/x.png"; document.body.append(other);
    other.dispatchEvent(new Event("error")); expect(other.src).toBe("http://127.0.0.1:3666/x.png");
  });
});
