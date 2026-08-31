import { useEffect, useRef } from "react";
import { AnchoredBox } from "../AnchoredBox";
import logo from "../assets/logo.png";
import type { DraftProtectionTextSettings } from "../types";
import { Atmosphere } from "../Atmosphere";
import layerStyles from "./full-cover-view.module.scss";
import logoStyles from "./bouncing-logo.module.scss";
import textStyles from "./draft-protection-text.module.scss";

const SPEED = 150;
const LOGO_SIZE_FRACTION = 0.22;
const SIZE_BASIS_FRACTION = 0.93;
const MIN_HUE_JUMP = 70;

function nextHue(current: number) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = Math.floor(Math.random() * 360);
    const delta = Math.min(Math.abs(candidate - current), 360 - Math.abs(candidate - current));
    if (delta >= MIN_HUE_JUMP) return candidate;
  }
  return (current + 180) % 360;
}

function BouncingLogo() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const viewport = viewportRef.current;
    const image = logoRef.current;
    if (!viewport || !image) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, previous = performance.now(), x = 0, y = 0;
    let hue = Math.floor(Math.random() * 360);
    const size = Math.min(viewport.clientWidth, viewport.clientHeight) * SIZE_BASIS_FRACTION * LOGO_SIZE_FRACTION;
    image.style.width = `${size}px`; image.style.height = `${size}px`;
    const maxX = Math.max(viewport.clientWidth - size, 0), maxY = Math.max(viewport.clientHeight - size, 0);
    x = reduced.matches ? maxX / 2 : Math.random() * maxX;
    y = reduced.matches ? maxY / 2 : Math.random() * maxY;
    const angle = Math.random() * Math.PI * 2;
    let vx = Math.cos(angle) * SPEED, vy = Math.sin(angle) * SPEED;
    const applyHue = () => { image.style.filter = `hue-rotate(${hue}deg) drop-shadow(0 0 26px hsla(${hue}, 85%, 62%, 0.4))`; };
    const paint = () => { image.style.transform = `translate3d(${x}px, ${y}px, 0)`; };
    const tick = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 0.05); previous = now;
      x += vx * dt; y += vy * dt;
      let collided = false;
      if (x <= 0) { x = 0; vx = Math.abs(vx); collided = true; }
      else if (x >= maxX) { x = maxX; vx = -Math.abs(vx); collided = true; }
      if (y <= 0) { y = 0; vy = Math.abs(vy); collided = true; }
      else if (y >= maxY) { y = maxY; vy = -Math.abs(vy); collided = true; }
      if (collided) { hue = nextHue(hue); applyHue(); }
      paint(); frame = requestAnimationFrame(tick);
    };
    applyHue(); paint();
    if (!reduced.matches) frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <div ref={viewportRef} className={logoStyles.viewport} aria-hidden="true"><img ref={logoRef} src={logo} className={logoStyles.logo} alt="" /></div>;
}

export function DraftProtectionLayer({ mode, text, sceneWidth, sceneHeight, editable = false }: { mode: "off" | "cover"; text?: DraftProtectionTextSettings; sceneWidth: number; sceneHeight: number; editable?: boolean }) {
  if (mode === "off") return null;
  const change = (patch: Partial<DraftProtectionTextSettings>) => window.parent.postMessage({ type: "prereborn-overlay-draft-text-change", patch }, "*");
  return <div className={layerStyles.layer} data-testid="draft-protection-layer"><Atmosphere seed={742} /><BouncingLogo />{text && text.content.trim() && <AnchoredBox layout={text} sceneWidth={sceneWidth} sceneHeight={sceneHeight} editable={editable} selected={editable} onChange={change}><div className={textStyles.text} data-editor-draggable={editable || undefined}>{text.content}</div></AnchoredBox>}</div>;
}
