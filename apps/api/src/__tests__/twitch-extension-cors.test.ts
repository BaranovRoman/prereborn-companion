import { describe, expect, it } from "vitest";
import { isTwitchExtensionOrigin } from "../config/cors.js";

// WK-157 - a real live-stream investigation into "quiz board renders but
// viewer interaction doesn't work" found that the Twitch Extension's
// currently-documented Local Test flow (docs/twitch-extension-setup.md §5a:
// a local self-signed HTTPS server, installed for real on the streamer's
// own channel) presents an origin CORS never allowlisted - only the
// deprecated Developer Rig's fixed origin was. Every fetch() from the
// extension during Local Test would fail closed silently (indistinguishable
// from a network outage), while Companion's own quiz board keeps rendering
// fine through a completely separate connection - exactly the reported
// symptom.
describe("isTwitchExtensionOrigin", () => {
    it("allows a Local Test server on 127.0.0.1 at any port", () => {
        expect(isTwitchExtensionOrigin("https://127.0.0.1:8443")).toBe(true);
        expect(isTwitchExtensionOrigin("https://127.0.0.1:9000")).toBe(true);
    });

    it("allows a Local Test server on localhost at any port", () => {
        expect(isTwitchExtensionOrigin("https://localhost:8443")).toBe(true);
    });

    it("rejects a Local Test origin over plain http (mixed content isn't the real scenario)", () => {
        expect(isTwitchExtensionOrigin("http://127.0.0.1:8443")).toBe(false);
    });

    it("rejects a Local Test-shaped origin on a non-loopback host", () => {
        expect(isTwitchExtensionOrigin("https://evil.example.com:8443")).toBe(false);
    });

    it("still allows the deprecated Developer Rig's fixed origin", () => {
        expect(isTwitchExtensionOrigin("https://localhost.rig.twitch.tv:8080")).toBe(true);
    });

    it("allows Twitch's own Hosted Test/Released CDN origin, scoped by pattern", () => {
        expect(isTwitchExtensionOrigin("https://abc123.ext-twitch.tv")).toBe(true);
    });

    it("rejects a look-alike CDN origin outside the real Twitch domain", () => {
        expect(isTwitchExtensionOrigin("https://abc123.ext-twitch.tv.evil.com")).toBe(false);
        expect(isTwitchExtensionOrigin("https://ext-twitch.tv")).toBe(false);
    });

    it("rejects an unrelated real-world origin", () => {
        expect(isTwitchExtensionOrigin("https://prereborn.ru")).toBe(false);
    });
});
