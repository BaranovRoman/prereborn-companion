"use client";

import { useEffect, useState } from "react";
import { Button, Input, Select, Space, message } from "antd";
import type { OverlayLayout } from "@/entities/stream-overlay-layout/model/types";
import { normalizeOverlayLayout } from "@/entities/stream-overlay-layout/model/normalize-layout";
import styles from "./index.module.scss";

const STORAGE_KEY = "prereborn:overlay-presets:v1";
type Preset = { id: string; name: string; layout: OverlayLayout };

const readPresets = (): Preset[] => {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
        return Array.isArray(parsed) ? parsed.flatMap((value) =>
            value && typeof value.id === "string" && typeof value.name === "string"
                ? [{ id: value.id, name: value.name.slice(0, 80), layout: normalizeOverlayLayout(value.layout) }]
                : []
        ) : [];
    } catch {
        return [];
    }
};

export const UserPresets = ({ layout, onApply }: {
    layout: OverlayLayout;
    onApply: (layout: OverlayLayout) => void;
}) => {
    const [presets, setPresets] = useState<Preset[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [messageApi, holder] = message.useMessage();
    useEffect(() => {
        // Presets are a browser-local external store; defer reading until hydration.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPresets(readPresets());
    }, []);
    const persist = (next: Preset[]) => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            setPresets(next);
            return true;
        } catch {
            messageApi.error("Не удалось сохранить пресет");
            return false;
        }
    };
    const active = presets.find((preset) => preset.id === activeId) ?? null;
    const create = () => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const preset = { id: crypto.randomUUID(), name: trimmed.slice(0, 80), layout };
        if (persist([...presets, preset])) {
            setActiveId(preset.id);
            setName("");
        }
    };
    return (
        <div className={styles.presetsSection}>
            {holder}
            <div className={styles.sectionTitle}>Пользовательские пресеты</div>
            <Space wrap>
                <Select placeholder="Безопасная базовая раскладка" value={activeId} allowClear style={{ minWidth: 220 }}
                    options={presets.map((preset) => ({ label: preset.name, value: preset.id }))}
                    onChange={(id) => {
                        setActiveId(id ?? null);
                        const preset = presets.find((item) => item.id === id);
                        if (preset) onApply(normalizeOverlayLayout(preset.layout));
                    }} />
                <Input placeholder="Название пресета" value={name} maxLength={80}
                    onChange={(event) => setName(event.target.value)} onPressEnter={create} />
                <Button onClick={create} disabled={!name.trim()}>Создать</Button>
                <Button disabled={!active} onClick={() => active && persist(presets.map((item) =>
                    item.id === active.id ? { ...item, layout } : item
                ))}>Обновить</Button>
                <Button disabled={!active} onClick={() => {
                    if (!active) return;
                    const copy = { ...active, id: crypto.randomUUID(), name: active.name + " copy" };
                    if (persist([...presets, copy])) setActiveId(copy.id);
                }}>Дублировать</Button>
                <Button disabled={!active} onClick={() => {
                    if (!active) return;
                    const nextName = name.trim();
                    if (nextName && persist(presets.map((item) =>
                        item.id === active.id ? { ...item, name: nextName.slice(0, 80) } : item
                    ))) setName("");
                }}>Переименовать</Button>
                <Button danger disabled={!active} onClick={() => {
                    if (!active) return;
                    if (persist(presets.filter((item) => item.id !== active.id))) setActiveId(null);
                }}>Удалить</Button>
            </Space>
            <div className={styles.hint}>
                Каждый пресет хранит полную конфигурацию overlay. Удаление активного пресета сохраняет текущую раскладку как безопасную базовую.
            </div>
        </div>
    );
};
