import { describe, expect, it } from "vitest";
import type { TwitchChatMessage } from "../core/contracts";
import { buildEmoteMap, loadEmoteCatalog, parseFfzSets } from "./emotes";
import {
  DEFAULT_OVERLAY_SETTINGS, badgeRoles, normalizeOverlaySettings, readableNameColor, tokenizeMessage, visibleMessages,
  type EmoteRef,
} from "./overlay-model";

const message = (id: string, text: string, extra: Partial<TwitchChatMessage> = {}): TwitchChatMessage => ({
  id, text, author: "Зритель", authorId: "1", authorLogin: "viewer", color: null, badges: [],
  messageType: "text", receivedAt: `2026-10-21T10:00:0${id}Z`, ...extra,
});
const emote = (code: string, source: EmoteRef["source"] = "7tv"): EmoteRef => ({ code, url: `https://cdn/${code}`, source });

describe("normalizeOverlaySettings", () => {
  it("falls back to defaults for missing or corrupted fields and clamps numbers", () => {
    expect(normalizeOverlaySettings(null)).toEqual(DEFAULT_OVERLAY_SETTINGS);
    expect(normalizeOverlaySettings({ style: "gm", fontSize: 400, backgroundOpacity: -5, maxMessages: Number.NaN, hideCommands: "no" }))
      .toEqual({ ...DEFAULT_OVERLAY_SETTINGS, fontSize: 32, backgroundOpacity: 0 });
  });
});

describe("visibleMessages", () => {
  it("drops commands, blanks and duplicate ids, keeping the newest maxMessages", () => {
    const list = [message("1", "привет"), message("2", "!song"), message("3", "  "), message("1", "привет"), message("4", "gg"), message("5", "wp")];
    expect(visibleMessages(list, { ...DEFAULT_OVERLAY_SETTINGS, maxMessages: 3 }).map((item) => item.id)).toEqual(["1", "4", "5"]);
    expect(visibleMessages(list, { ...DEFAULT_OVERLAY_SETTINGS, hideCommands: false }).map((item) => item.id)).toEqual(["1", "2", "4", "5"]);
  });
});

describe("tokenizeMessage", () => {
  it("keeps text between several third-party emotes verbatim, including Cyrillic", () => {
    const parts = tokenizeMessage(message("1", "ну KEKW это  PogU!  PogU"), buildEmoteMap([emote("KEKW"), emote("PogU", "bttv")]));
    expect(parts).toEqual([
      { kind: "text", text: "ну " },
      { kind: "emote", emote: emote("KEKW") },
      { kind: "text", text: " это  PogU!  " },
      { kind: "emote", emote: emote("PogU", "bttv") },
    ]);
  });

  it("uses EventSub fragments for Twitch-native emotes", () => {
    const parts = tokenizeMessage(message("1", "Kappa hi", {
      fragments: [{ type: "emote", text: "Kappa", emote: { id: "25" } }, { type: "text", text: " hi" }],
    }), new Map());
    expect(parts[0]).toEqual({ kind: "emote", emote: { code: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0", source: "twitch" } });
    expect(parts[1]).toEqual({ kind: "text", text: " hi" });
  });
});

describe("badges and colors", () => {
  it("maps Twitch badge sets to highlighted roles in a stable order", () => {
    expect(badgeRoles(["subscriber/12", "moderator/1", "premium/1"])).toEqual(["moderator", "subscriber"]);
    expect(badgeRoles(["founder/0"])).toEqual(["subscriber"]);
  });

  it("lifts unreadably dark name colors and keeps bright ones", () => {
    expect(readableNameColor("#FF7F50", "a")).toBe("#ff7f50");
    expect(readableNameColor("#0000FF", "a")).not.toBe("#0000ff");
    expect(readableNameColor(null, "a")).toBe(readableNameColor(null, "a"));
  });
});

describe("loadEmoteCatalog", () => {
  it("resolves the channel id through FFZ and survives a failing provider", async () => {
    const responses: Record<string, unknown> = {
      "https://api.frankerfacez.com/v1/room/streamer": { room: { twitch_id: 42 }, sets: { 9: { emoticons: [{ name: "ffzChan", urls: { 1: "//cdn.ffz/1" } }] } } },
      "https://api.frankerfacez.com/v1/set/global": { default_sets: [3], sets: { 3: { emoticons: [{ name: "ffzGlobal", urls: { 1: "https://cdn.ffz/g" } }] }, 4: { emoticons: [{ name: "notDefault", urls: { 1: "x" } }] } } },
      "https://api.betterttv.net/3/cached/users/twitch/42": { channelEmotes: [{ id: "b1", code: "Same" }], sharedEmotes: [] },
      "https://7tv.io/v3/users/twitch/42": { emote_set: { emotes: [{ id: "s1", name: "Same" }] } },
    };
    const catalog = await loadEmoteCatalog("Streamer", null, async (url) => {
      if (!(url in responses)) throw new Error("404");
      return responses[url];
    });
    const map = buildEmoteMap(catalog);
    expect(map.get("ffzChan")?.url).toBe("https://cdn.ffz/1");
    expect(map.has("ffzGlobal")).toBe(true);
    expect(map.has("notDefault")).toBe(false);
    expect(map.get("Same")?.source).toBe("7tv");
  });

  it("ignores malformed FFZ payloads", () => {
    expect(parseFfzSets({ 1: { emoticons: [{ name: "x" }, null, "junk"] } })).toEqual([]);
  });
});
