"use client";

import { useEffect } from "react";
import { Button, Tag } from "antd";
import {
    DOTA_COMPANION_DOWNLOAD_URL,
    DOTA_COMPANION_VERSION,
} from "@/shared/config/dota-companion";
import { usePageReady } from "@/shared/ui/route-transition/usePageReady";
import styles from "./index.module.scss";

export const StreamDownloadPage = () => {
    const { ready } = usePageReady(600);
    useEffect(() => {
        ready();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className={styles.page}>
            <div className={styles.card}>
                <div className={styles.header}>
                    <h1 className={styles.title}>Dota Companion</h1>
                    <Tag color="gold">Beta / Experimental</Tag>
                </div>

                <p className={styles.description}>
                    Небольшое desktop-приложение для Windows, которое читает
                    состояние матча Dota 2 через официальный Game State
                    Integration и передаёт его в ваш стрим-оверлей на этом
                    сайте.
                </p>

                <div className={styles.meta}>
                    <span>Windows x64</span>
                    <span>·</span>
                    <span>Версия {DOTA_COMPANION_VERSION}</span>
                </div>

                <div className={styles.downloadRow}>
                    {DOTA_COMPANION_DOWNLOAD_URL ? (
                        <Button type="primary" size="large" href={DOTA_COMPANION_DOWNLOAD_URL}>
                            Скачать для Windows
                        </Button>
                    ) : (
                        <Button type="primary" size="large" disabled>
                            Скоро — установщик готовится
                        </Button>
                    )}
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>Установка</h2>
                    <ol className={styles.steps}>
                        <li>Скачайте и запустите установщик (Setup.exe).</li>
                        <li>
                            Откройте Dota Companion — он сам найдёт Dota 2 и
                            настроит Game State Integration.
                        </li>
                        <li>
                            В настройках{" "}
                            <a href="/stream">стрим-оверлея</a> создайте
                            companion-токен и вставьте его в приложение.
                        </li>
                    </ol>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>Предупреждение Windows</h2>
                    <p className={styles.hint}>
                        Это тестовая сборка без цифровой подписи — Windows
                        SmartScreen может показать предупреждение
                        «Windows защитила ваш компьютер». Нажмите{" "}
                        <strong>«Подробнее»</strong>, затем{" "}
                        <strong>«Выполнить в любом случае»</strong>.
                    </p>
                </div>

                <div className={styles.section}>
                    <h2 className={styles.sectionTitle}>Безопасность</h2>
                    <ul className={styles.securityList}>
                        <li>Не читает память Dota 2.</li>
                        <li>Не внедряется в процесс игры.</li>
                        <li>Не управляет вводом (клавиатура/мышь).</li>
                        <li>
                            Получает данные только через официальный Game
                            State Integration — тот же механизм, что
                            используют публичные оверлеи и трекеры.
                        </li>
                    </ul>
                </div>
            </div>
        </div>
    );
};
