import type { GameplayProtectionSettings } from "@/entities/stream-overlay-layout/model/types";
import styles from "./gameplay-protection-layer.module.scss";

export const GameplayProtectionLayer = ({ settings }: { settings?: GameplayProtectionSettings }) => {
    if (!settings?.enabled) return null;
    return (
        <>
            {settings.zones.filter((zone) => zone.enabled).map((zone) => (
                <div key={zone.id} className={styles.zone} aria-hidden="true"
                    style={{ left: zone.x, top: zone.y, width: zone.width, height: zone.height }} />
            ))}
        </>
    );
};
