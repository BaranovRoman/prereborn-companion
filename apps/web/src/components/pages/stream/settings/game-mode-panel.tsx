"use client";

import { useState } from "react";
import { Segmented, message } from "antd";
import { streamAuthApi } from "@/entities/stream-user/api/stream-auth";
import type { StreamGameMode } from "@/entities/stream-user/model/types";

const GAME_MODE_OPTIONS = [
    { label: "Рейтинговые", value: "ranked" as const },
    { label: "Обычные", value: "unranked" as const },
];

interface GameModePanelProps {
    gameMode: StreamGameMode;
    onChanged: (gameMode: StreamGameMode) => void;
}

// Режим матчей - см. задачу "Ranked/Unranked". Переключение меняет ТОЛЬКО
// текущую настройку пользователя (PATCH /account/me/game-mode) - ни уже
// записанные stream_matches, ни текущий session rating/W-L не трогаются
// (см. backend stream-match-service.ts - следующий финализируемый GSI-матч
// прочитает новое значение), поэтому в отличие от "Начать новый стрим" здесь
// не нужен Popconfirm.
export const GameModePanel = ({ gameMode, onChanged }: GameModePanelProps) => {
    const [displayMode, setDisplayMode] = useState<StreamGameMode>(gameMode);
    const [saving, setSaving] = useState(false);
    const [messageApi, contextHolder] = message.useMessage();

    const handleChange = async (value: StreamGameMode) => {
        if (value === displayMode || saving) return;
        const prev = displayMode;
        setDisplayMode(value);
        setSaving(true);
        try {
            const updated = await streamAuthApi.setGameMode(value);
            setDisplayMode(updated.gameMode);
            onChanged(updated.gameMode);
        } catch {
            setDisplayMode(prev);
            messageApi.error("Не удалось сохранить режим");
        } finally {
            setSaving(false);
        }
    };

    return (
        <>
            {contextHolder}
            <Segmented
                block
                disabled={saving}
                value={displayMode}
                options={GAME_MODE_OPTIONS}
                onChange={handleChange}
            />
        </>
    );
};
