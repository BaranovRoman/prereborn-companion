"use client";

import { useState } from "react";
import Link from "next/link";
import axios from "axios";
import { Button, Popconfirm, message } from "antd";
import { streamAuthApi } from "@/entities/stream-user/api/stream-auth";
import sharedStyles from "./index.module.scss";
import styles from "./companion-panel.module.scss";

interface CompanionPanelProps {
    companionTokenConfigured: boolean;
    companionTokenCreatedAt: string | null;
    onRegenerated: (createdAt: string) => void;
}

const formatDate = (iso: string): string =>
    new Date(iso).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

// Токен показывается ровно один раз, сразу после генерации - если
// пользователь закроет/обновит страницу, увидеть его снова нельзя, только
// сгенерировать новый (старый при этом перестанет работать).
export const CompanionPanel = ({
    companionTokenConfigured,
    companionTokenCreatedAt,
    onRegenerated,
}: CompanionPanelProps) => {
    const [messageApi, contextHolder] = message.useMessage();
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [revealedToken, setRevealedToken] = useState<string | null>(null);

    const handleRegenerate = async () => {
        setIsRegenerating(true);
        try {
            const result = await streamAuthApi.regenerateCompanionToken();
            setRevealedToken(result.token);
            onRegenerated(result.companionTokenCreatedAt);
        } catch (error) {
            // Не маскируем ошибку общим сообщением без следа - в dev полностью
            // видно, что реально произошло (status/body/exception), не только
            // "не удалось". stream-client.ts уже пытается прозрачно обновить
            // просроченный access-токен (interceptors.response) - если 401
            // всё равно дошёл сюда, значит и refresh-токен недействителен.
            if (process.env.NODE_ENV !== "production") {
                if (axios.isAxiosError(error)) {
                    // eslint-disable-next-line no-console
                    console.error(
                        "[CompanionPanel] regenerateCompanionToken failed",
                        {
                            status: error.response?.status,
                            body: error.response?.data,
                            message: error.message,
                        }
                    );
                } else {
                    // eslint-disable-next-line no-console
                    console.error(
                        "[CompanionPanel] regenerateCompanionToken failed",
                        error
                    );
                }
            }

            const status = axios.isAxiosError(error)
                ? error.response?.status
                : undefined;
            if (status === 401) {
                messageApi.error(
                    "Сессия истекла — обновите страницу и войдите заново."
                );
            } else {
                messageApi.error("Не удалось сгенерировать токен");
            }
        } finally {
            setIsRegenerating(false);
        }
    };

    const handleCopy = async () => {
        if (!revealedToken) return;
        await navigator.clipboard.writeText(revealedToken);
        messageApi.success("Токен скопирован");
    };

    return (
        <div className={sharedStyles.section}>
            {contextHolder}
            <h2 className={sharedStyles.sectionTitle}>Companion</h2>
            <div className={styles.statusLine}>
                {companionTokenConfigured
                    ? "Токен настроен"
                    : "Токен ещё не создан"}
            </div>
            {companionTokenCreatedAt && !revealedToken && (
                <div className={styles.metaLine}>
                    Создан: {formatDate(companionTokenCreatedAt)}
                </div>
            )}

            {revealedToken ? (
                <div className={styles.tokenBox}>
                    <div className={styles.tokenHint}>
                        Вставьте этот токен в Dota Companion (поле «Companion
                        token»). Он показывается только сейчас — сохраните его.
                    </div>
                    <div className={styles.tokenRow}>
                        <input
                            readOnly
                            value={revealedToken}
                            className={styles.tokenInput}
                            onFocus={(e) => e.currentTarget.select()}
                        />
                        <Button onClick={handleCopy}>Скопировать</Button>
                    </div>
                </div>
            ) : (
                <div className={styles.actions}>
                    <Popconfirm
                        title={
                            companionTokenConfigured
                                ? "Сгенерировать новый токен?"
                                : "Создать токен для companion?"
                        }
                        description={
                            companionTokenConfigured
                                ? "Старый токен сразу перестанет работать — companion придётся перенастроить."
                                : "Токен нужен, чтобы companion мог отправлять состояние игры на сайт."
                        }
                        okText={companionTokenConfigured ? "Перегенерировать" : "Создать"}
                        cancelText="Отмена"
                        onConfirm={handleRegenerate}
                    >
                        <Button
                            type={companionTokenConfigured ? "default" : "primary"}
                            loading={isRegenerating}
                        >
                            {companionTokenConfigured
                                ? "Перегенерировать токен"
                                : "Создать токен"}
                        </Button>
                    </Popconfirm>
                </div>
            )}

            <div className={styles.downloadHint}>
                Companion — desktop-приложение для Windows, которое читает
                Dota Game State Integration и передаёт состояние на этот
                сайт.{" "}
                <Link href="/stream/download">Скачать companion</Link>
            </div>
        </div>
    );
};
