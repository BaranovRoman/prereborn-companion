"use client";

import { useState } from "react";
import { Button, message } from "antd";
import type { BroadcastSceneId } from "@/entities/stream-overlay-layout/model/types";
import { obsSceneControlApi } from "@/entities/stream-session/api/obs-scene-control";
import styles from "./obs-test-mode.module.scss";

const SCENES: Array<{ id: BroadcastSceneId; label: string }> = [
    { id: "betweenMatches", label: "Между матчами" },
    { id: "draft", label: "Драфт" },
    { id: "gameplay", label: "Игра" },
];

export const ObsTestMode = ({ companionOnline }: { companionOnline: boolean }) => {
    const [pending, setPending] = useState<BroadcastSceneId | null>(null);
    const [messageApi, contextHolder] = message.useMessage();

    const switchScene = async (scene: BroadcastSceneId) => {
        setPending(scene);
        try {
            await obsSceneControlApi.testScene(scene);
            messageApi.success("Команда отправлена в Companion");
        } catch {
            messageApi.error("Не удалось отправить команду");
        } finally {
            setPending(null);
        }
    };

    return (
        <div className={styles.panel}>
            {contextHolder}
            <div>
                <strong>Тест сцен OBS</strong>
                <span>
                Временно переключает Program Scene и сам overlay независимо от текущей фазы Dota. Через минуту overlay снова перейдёт в автоматический режим.
                </span>
            </div>
            <div className={styles.buttons}>
                {SCENES.map((scene) => (
                    <Button
                        key={scene.id}
                        disabled={!companionOnline}
                        loading={pending === scene.id}
                        onClick={() => void switchScene(scene.id)}
                    >
                        {scene.label}
                    </Button>
                ))}
            </div>
            {!companionOnline && (
                <small>Запустите Companion, чтобы использовать тестовый режим.</small>
            )}
        </div>
    );
};
