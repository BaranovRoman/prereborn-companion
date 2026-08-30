import type { CSSProperties } from "react";
import cleanMap from "./assets/minimap/dota-current-clean-minimap.png";
import dotabodMap from "./assets/minimap/dotabod-stream-sniper-cover.png";
import observerWard from "./assets/minimap/ward-observer.png";
import sentryWard from "./assets/minimap/ward-sentry.png";
import type { MinimapCoverSettings } from "./types";
import styles from "./anti-snipe-layer.module.scss";

type Preset = MinimapCoverSettings["preset"];
type Ward = { id: number; x: number; y: number; dx: number; dy: number; team: "radiant" | "dire"; kind: "observer" | "sentry"; duration: number; delay: number };
const counts: Record<Preset, number> = { clean: 0, "random-a": 0, "random-b": 56, "random-dense": 74, interactive: 60 };
const seeds: Record<Preset, number> = { clean: 1, "random-a": 7401, "random-b": 7402, "random-dense": 7403, interactive: 7404 };

export function createMinimapWards(preset: Preset): Ward[] {
  let state = seeds[preset];
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: counts[preset] }, (_, id) => ({
    id, x: 7 + random() * 86, y: 7 + random() * 86,
    dx: (random() - 0.5) * 13, dy: (random() - 0.5) * 13,
    team: random() > 0.14 ? "radiant" : "dire",
    kind: random() > 0.38 ? "observer" : "sentry",
    duration: 3.8 + random() * 5.2, delay: -random() * 7,
  }));
}

export function AntiSnipeLayer({ settings }: { settings?: MinimapCoverSettings }) {
  if (!settings?.enabled) return null;
  const vertical = settings.anchor.startsWith("bottom") ? { bottom: settings.y } : { top: settings.y };
  const horizontal = settings.anchor.endsWith("right") ? { right: settings.x } : { left: settings.x };
  const interactive = settings.preset === "interactive";
  return (
    <div className={styles.minimapCover} data-testid="minimap-cover" style={{ width: settings.size, height: settings.size, ...vertical, ...horizontal }}>
      <svg className={styles.colorFilters} aria-hidden="true"><filter id="ward-radiant" colorInterpolationFilters="sRGB"><feColorMatrix values="0.44 0 0 0 0  0 1 0 0 0  0 0 0.21 0 0  0 0 0 1 0" /></filter><filter id="ward-dire" colorInterpolationFilters="sRGB"><feColorMatrix values="1 0 0 0 0  0 0.15 0 0 0  0 0 0.2 0 0  0 0 0 1 0" /></filter></svg>
      <img className={styles.mapBase} src={settings.preset === "random-a" ? dotabodMap : cleanMap} alt="" />
      <div className={styles.wardLayer}>{createMinimapWards(settings.preset).map((ward) => <img key={ward.id} className={`${styles.ward} ${styles[ward.team]} ${interactive ? styles.moving : ""}`} src={ward.kind === "observer" ? observerWard : sentryWard} alt="" style={{ "--x": `${ward.x}%`, "--y": `${ward.y}%`, "--dx": `${ward.dx}%`, "--dy": `${ward.dy}%`, "--duration": `${ward.duration}s`, "--delay": `${ward.delay}s` } as CSSProperties} />)}</div>
    </div>
  );
}
