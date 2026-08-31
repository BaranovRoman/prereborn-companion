import { RedFogBackground } from "../../web/src/components/pages/stream/queue/red-fog-background";
import treeFarUrl from "../../web/public/generated/chatgpt/trees-1.png";
import treeMiddleUrl from "../../web/public/generated/chatgpt/trees-2.png";
import treeNearUrl from "../../web/public/generated/chatgpt/trees-3.png";
import styles from "../../web/src/components/pages/stream/queue/queue-scene.module.scss";

export function Atmosphere({ seed = 123 }: { seed?: number }) {
  const treeStyle = { position: "absolute", inset: 0, width: "100%", height: "100%" } as const;
  return <div className="ov-atmosphere-stage" aria-hidden="true">
    <div className={styles.fallback} aria-hidden="true" />
    <div className={styles.treeStage} aria-hidden="true">
      <div className={`${styles.treeLayer} ${styles.treeDistantSilhouette}`}><img className={styles.treeImage} style={treeStyle} src={treeMiddleUrl} alt="" /></div>
      <div className={`${styles.treeLayer} ${styles.treeFar}`}><img className={styles.treeImage} style={treeStyle} src={treeFarUrl} alt="" /></div>
      <div className={`${styles.treeLayer} ${styles.treeMiddle}`}><img className={styles.treeImage} style={treeStyle} src={treeMiddleUrl} alt="" /></div>
      <div className={`${styles.treeLayer} ${styles.treeNear}`}><img className={styles.treeImage} style={treeStyle} src={treeNearUrl} alt="" /></div>
      <div className={styles.treeFogMiddle} /><div className={styles.treeFogFront} />
    </div>
    {import.meta.env.MODE !== "test" && typeof window.matchMedia === "function" && <RedFogBackground quality="high" seed={seed} forceFallback={false} onDebugStateChange={() => undefined} />}
    <div className={styles.atmosphereFinish} aria-hidden="true" />
  </div>;
}
