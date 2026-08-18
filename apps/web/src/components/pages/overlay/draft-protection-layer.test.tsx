import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DraftProtectionLayer } from "./draft-protection-layer";

afterEach(cleanup);

describe("DraftProtectionLayer", () => {
    it("renders the cinematic draft scene when protection is off", () => {
        const { getByTestId } = render(<DraftProtectionLayer mode="off" payload={null} />);
        expect(getByTestId("cinematic-draft-layer")).toBeTruthy();
    });

    it("renders an opaque cover without real draft data", () => {
        const { getByTestId } = render(<DraftProtectionLayer mode="cover" />);
        expect(getByTestId("draft-protection-layer").textContent).toContain(
            "Выбор героев скрыт"
        );
    });

    it("renders the fake draft picker for the substitute mode", () => {
        const { getByTestId } = render(
            <DraftProtectionLayer mode="substitute" payload={null} />
        );
        const text = getByTestId("fake-draft-picker").textContent;
        expect(text).toContain("PUBLIC DRAFT");
        expect(text).toContain("не связана с реальными пиками и банами");
    });
});
