import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GameplayProtectionLayer } from "./gameplay-protection-layer";

describe("GameplayProtectionLayer", () => {
    it("renders only enabled permanent zones", () => {
        const { container } = render(<GameplayProtectionLayer settings={{
            enabled: true,
            zones: [
                { id: "buyback", label: "Buyback", enabled: true, x: 10, y: 20, width: 30, height: 40 },
                { id: "disabled", label: "Disabled", enabled: false, x: 0, y: 0, width: 10, height: 10 },
            ],
        }} />);
        expect(container.children).toHaveLength(1);
        const zone = container.firstElementChild as HTMLElement;
        expect(zone.style.left).toBe("10px");
        expect(zone.style.top).toBe("20px");
        expect(zone.style.width).toBe("30px");
        expect(zone.style.height).toBe("40px");
    });

    it("renders nothing outside gameplay when settings are omitted", () => {
        const { container } = render(<GameplayProtectionLayer />);
        expect(container.children).toHaveLength(0);
    });
});
