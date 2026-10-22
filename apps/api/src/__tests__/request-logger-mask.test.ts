import { describe, expect, it } from "vitest";
import { maskLogPath } from "../middleware/request-logger.js";

describe("request logger path masking (WK-196)", () => {
    it("masks the public overlay token", () => {
        expect(maskLogPath("/api/stream/overlay/3f2b9c1e-token")).toBe("/api/stream/overlay/[token]");
        expect(maskLogPath("/overlay/3f2b9c1e-token/extra")).toBe("/overlay/[token]/extra");
    });

    it("leaves other paths unchanged", () => {
        expect(maskLogPath("/api/stream/account/me/overlay-layout")).toBe("/api/stream/account/me/overlay-layout");
        expect(maskLogPath("/api/stream/integrations/twitch/callback")).toBe("/api/stream/integrations/twitch/callback");
        expect(maskLogPath("/api/stream/overlay/")).toBe("/api/stream/overlay/");
    });
});
