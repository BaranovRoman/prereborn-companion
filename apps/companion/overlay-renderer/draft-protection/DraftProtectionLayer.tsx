import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AnchoredBox } from "../AnchoredBox";
import logo from "../assets/logo.png";
import type { DraftProtectionTextSettings } from "../types";
import layerStyles from "./full-cover-view.module.scss";
import logoStyles from "./bouncing-logo.module.scss";
import textStyles from "./draft-protection-text.module.scss";

const SPEED = 150;

function BouncingLogo() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const viewport = viewportRef.current;
    const image = logoRef.current;
    if (!viewport || !image) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, previous = performance.now(), x = 0, y = 0, vx = SPEED, vy = SPEED * 0.72;
    const size = Math.min(viewport.clientWidth, viewport.clientHeight) * 0.2046;
    image.style.width = `${size}px`; image.style.height = `${size}px`;
    x = (viewport.clientWidth - size) / 2; y = (viewport.clientHeight - size) / 2;
    const paint = () => { image.style.transform = `translate3d(${x}px, ${y}px, 0)`; };
    const tick = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 0.05); previous = now;
      x += vx * dt; y += vy * dt;
      const maxX = Math.max(viewport.clientWidth - size, 0), maxY = Math.max(viewport.clientHeight - size, 0);
      if (x <= 0 || x >= maxX) { x = Math.max(0, Math.min(maxX, x)); vx *= -1; }
      if (y <= 0 || y >= maxY) { y = Math.max(0, Math.min(maxY, y)); vy *= -1; }
      paint(); frame = requestAnimationFrame(tick);
    };
    paint();
    if (!reduced.matches) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div ref={viewportRef} className={logoStyles.viewport} aria-hidden="true"><img ref={logoRef} src={logo} className={logoStyles.logo} alt="" /></div>;
}

export function DraftProtectionLayer({ mode, text, sceneWidth, sceneHeight, editable = false }: { mode: "off" | "cover"; text?: DraftProtectionTextSettings; sceneWidth: number; sceneHeight: number; editable?: boolean }) {
  const [drag, setDrag] = useState<{ pointerId: number; startX: number; startY: number; dx: number; dy: number } | null>(null);
  if (mode === "off") return null;
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dx: 0, dy: 0 });
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setDrag({ ...drag, dx: event.clientX - drag.startX, dy: event.clientY - drag.startY });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || !text || event.pointerId !== drag.pointerId) return;
    window.parent.postMessage({ type: "prereborn-overlay-draft-text-position", xVw: Math.max(0, Math.min(100, text.xVw + drag.dx / sceneWidth * 100)), yVh: Math.max(0, Math.min(100, text.yVh + drag.dy / sceneHeight * 100)) }, "*");
    setDrag(null);
  };
  return <div className={layerStyles.layer} data-testid="draft-protection-layer"><div className="ov-draft-atmosphere" /><BouncingLogo />{text && text.content.trim() && <AnchoredBox layout={text} sceneWidth={sceneWidth} sceneHeight={sceneHeight}><div className={textStyles.text} data-editor-draggable={editable || undefined} style={{ cursor: editable ? "move" : undefined, transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined, outline: editable ? "1px dashed rgba(218,180,112,.8)" : undefined, touchAction: "none" }} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>{text.content}</div></AnchoredBox>}</div>;
}
