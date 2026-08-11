import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DraftProtectionLayer } from "./draft-protection-layer";

afterEach(cleanup);

describe("DraftProtectionLayer", () => {
    it("renders no layer when the user explicitly disables protection", () => {
        const { container } = render(<DraftProtectionLayer mode="off" />);
        expect(container.childElementCount).toBe(0);
    });

    it("renders an opaque cover without real draft data", () => {
        const { getByTestId } = render(<DraftProtectionLayer mode="cover" />);
        expect(getByTestId("draft-protection-layer").textContent).toContain(
            "Выбор героев скрыт"
        );
    });

    it("renders only the static public substitute model", () => {
        const { getByTestId } = render(
            <DraftProtectionLayer mode="substitute" />
        );
        const text = getByTestId("draft-protection-layer").textContent;
        expect(text).toContain("PUBLIC DRAFT");
        expect(text).toContain("Crystal Maiden");
        expect(text).toContain("не связана с реальными пиками и банами");
    });
});