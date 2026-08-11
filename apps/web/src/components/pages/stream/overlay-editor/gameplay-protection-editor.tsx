import { Button, Input, InputNumber, Switch } from "antd";
import type { GameplayProtectionSettings, GameplayProtectionZone } from "@/entities/stream-overlay-layout/model/types";
import styles from "./index.module.scss";

export const GameplayProtectionEditor = ({ value, onChange }: {
    value: GameplayProtectionSettings;
    onChange: (value: GameplayProtectionSettings) => void;
}) => {
    const patchZone = (id: string, patch: Partial<GameplayProtectionZone>) =>
        onChange({ ...value, zones: value.zones.map((zone) => zone.id === id ? { ...zone, ...patch } : zone) });
    const addZone = () => onChange({ ...value, zones: [...value.zones, {
        id: crypto.randomUUID(), label: "Buyback", enabled: true,
        x: 760, y: 0, width: 80, height: 24,
    }] });
    return (
        <div className={styles.cameraSection}>
            <div className={styles.cameraSectionHeader}>
                <div>
                    <div className={styles.sectionTitle}>Gameplay anti-snipe</div>
                    <div className={styles.cameraHint}>Постоянные нейтральные плашки в виртуальной сцене шириной 1920 px. Состояние buyback не определяется.</div>
                </div>
                <Switch checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
            </div>
            {value.enabled && <div className={styles.widgetBody}>
                {value.zones.map((zone) => <div className={styles.cameraFields} key={zone.id}>
                    <Switch checked={zone.enabled} onChange={(enabled) => patchZone(zone.id, { enabled })} />
                    <Input value={zone.label} maxLength={80} onChange={(event) => patchZone(zone.id, { label: event.target.value })} />
                    {(["x", "y", "width", "height"] as const).map((field) => <label key={field}>
                        <span>{field}, px</span>
                        <InputNumber min={field === "width" || field === "height" ? 8 : 0}
                            max={field === "x" || field === "width" ? 1920 : 1080}
                            value={zone[field]} onChange={(next) => next !== null && patchZone(zone.id, { [field]: next })} />
                    </label>)}
                    <Button danger onClick={() => onChange({ ...value, zones: value.zones.filter((item) => item.id !== zone.id) })}>Удалить</Button>
                </div>)}
                <Button onClick={addZone} disabled={value.zones.length >= 20}>Добавить защищаемую область</Button>
            </div>}
        </div>
    );
};
