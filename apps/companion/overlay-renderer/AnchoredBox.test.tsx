// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnchoredBox } from "./AnchoredBox";
import type { OverlayWidgetLayout } from "./types";

afterEach(() => cleanup());

// jsdom doesn't implement ResizeObserver at all - AnchoredBox's real (and
// entirely reasonable) use of it to re-measure on resize would otherwise
// throw before this component ever gets to render anything in a test.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver ??= StubResizeObserver;

const BASE: OverlayWidgetLayout = { xVw: 10, yVh: 20, scale: 1, visible: true, anchor: "top-left" };

// jsdom has no real layout engine (offsetWidth/offsetHeight are always 0
// without this), so the anchor-fraction offset (which is proportional to
// the widget's own measured size) would be indistinguishable from zero for
// every anchor otherwise - stubbing a concrete size is what lets the
// bottom-right test below actually exercise that math, not just the
// anchor-point placement any anchor would pass with a zero-size box.
// Restores the original descriptors afterward so this stub never leaks
// into any other test in this file (or beyond it).
function withStubbedMeasuredSize(width: number, height: number, run: () => void) {
  const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: width });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: height });
  try {
    run();
  } finally {
    if (originalWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalWidth);
    if (originalHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalHeight);
  }
}

describe("AnchoredBox", () => {
  it("renders nothing at all when the widget is not visible - not just visually hidden", () => {
    const { container } = render(
      <AnchoredBox layout={{ ...BASE, visible: false }} sceneWidth={1920} sceneHeight={1080}>
        <span>content</span>
      </AnchoredBox>
    );
    expect(container.firstChild).toBeNull();
  });

  it("top-left anchor places the box's own top-left corner exactly at (xVw, yVh)", () => {
    const { container } = render(
      <AnchoredBox layout={{ ...BASE, xVw: 10, yVh: 20 }} sceneWidth={1920} sceneHeight={1080}>
        <span>content</span>
      </AnchoredBox>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.left).toBe(`${(10 / 100) * 1920}px`);
    expect(wrapper.style.top).toBe(`${(20 / 100) * 1080}px`);
  });

  it("bottom-right anchor offsets the wrapper by the full measured (scaled) size", () => {
    withStubbedMeasuredSize(200, 100, () => {
      const { container } = render(
        <AnchoredBox layout={{ xVw: 50, yVh: 50, scale: 2, visible: true, anchor: "bottom-right" }} sceneWidth={1920} sceneHeight={1080}>
          <span>content</span>
        </AnchoredBox>
      );
      const wrapper = container.firstChild as HTMLElement;
      const anchorX = (50 / 100) * 1920;
      const anchorY = (50 / 100) * 1080;
      // scaledWidth/Height = measured size * layout.scale (200*2, 100*2) -
      // the full box must sit to the top-left of the anchor point.
      expect(wrapper.style.left).toBe(`${anchorX - 200 * 2}px`);
      expect(wrapper.style.top).toBe(`${anchorY - 100 * 2}px`);
      expect(wrapper.style.width).toBe("400px");
      expect(wrapper.style.height).toBe("200px");
    });
  });

  it("applies the configured scale as a CSS transform on the inner content", () => {
    const { container } = render(
      <AnchoredBox layout={{ ...BASE, scale: 1.5 }} sceneWidth={1920} sceneHeight={1080}>
        <span>content</span>
      </AnchoredBox>
    );
    const inner = (container.firstChild as HTMLElement).firstChild as HTMLElement;
    expect(inner.style.transform).toBe("scale(1.5)");
  });

  it("shows editor bounds and a resize handle only for the selected widget", () => {
    const onChange = vi.fn();
    const { container } = render(
      <div data-scene-root="true"><AnchoredBox layout={BASE} sceneWidth={1920} sceneHeight={1080} editable selected onChange={onChange}>
        <span>content</span>
      </AnchoredBox></div>
    );
    expect(container.querySelector('[data-editor-widget="true"]')).toBeTruthy();
    expect(screen.getByLabelText("Resize widget")).toBeTruthy();
  });

  it("allows direct resize beyond the removed 2x UI ceiling", () => {
    const onChange = vi.fn();
    render(<div data-scene-root="true"><AnchoredBox layout={BASE} sceneWidth={1920} sceneHeight={1080} editable selected onChange={onChange} minimumScale={0.05} maximumScale={null}><span>content</span></AnchoredBox></div>);
    const handle = screen.getByLabelText("Resize widget");
    Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 580, clientY: 100 });
    expect(onChange).toHaveBeenCalledWith({ scale: 3 });
  });

  it("emits persisted layout coordinates when dragged directly in the preview", () => {
    const onChange = vi.fn();
    const { container } = render(
      <div data-scene-root="true" style={{ width: 1920, height: 1080 }}><AnchoredBox layout={BASE} sceneWidth={1920} sceneHeight={1080} editable onChange={onChange}>
        <span>content</span>
      </AnchoredBox></div>
    );
    const wrapper = container.querySelector<HTMLElement>('[data-editor-widget="true"]')!;
    Object.defineProperty(wrapper, "setPointerCapture", { value: vi.fn() });
    const scene = container.querySelector<HTMLElement>('[data-scene-root="true"]')!;
    scene.getBoundingClientRect = () => ({ width: 1920, height: 1080, x: 0, y: 0, top: 0, left: 0, right: 1920, bottom: 1080, toJSON: () => ({}) });
    fireEvent.pointerDown(wrapper, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(wrapper, { pointerId: 1, clientX: 292, clientY: 208 });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ xVw: 20, yVh: 30 }));
  });
});
