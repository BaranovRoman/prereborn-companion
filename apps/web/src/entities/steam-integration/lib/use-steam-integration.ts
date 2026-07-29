"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { steamIntegrationApi } from "../api/steam-integration";
import type { SteamIntegrationStatus } from "../model/types";

// 30-60с из задачи - берём верхнюю границу: страница /stream не единственный
// источник sync, пока она открыта, overlay poll (каждые 5с) уже фонит sync
// на том же сервере с тем же cooldown, так что более частый локальный опрос
// тут не нужен.
const AUTO_SYNC_INTERVAL_MS = 45_000;

export const useSteamIntegration = () => {
    const [status, setStatus] = useState<SteamIntegrationStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [isSyncing, setIsSyncing] = useState(false);

    const statusRef = useRef(status);
    statusRef.current = status;
    const isSyncingRef = useRef(false);

    const loadStatus = useCallback(async () => {
        try {
            const data = await steamIntegrationApi.getStatus();
            setStatus(data);
        } catch {
            // Временная ошибка - не затираем уже показанный статус.
        } finally {
            setLoading(false);
        }
    }, []);

    // Общий путь для фонового автосинка и ручной кнопки - оба бьют в один
    // и тот же authenticated endpoint с одним и тем же серверным cooldown/
    // in-flight lock (dota-sync-service.ts), так что параллельного запуска
    // или обхода cooldown с клиента не бывает физически, а не по договорённости.
    const runSync = useCallback(async () => {
        try {
            await steamIntegrationApi.sync();
        } catch {
            // Ошибка sync не критична для UI - ниже всё равно перечитываем
            // актуальный статус (включая lastSyncStatus с сервера).
        } finally {
            await loadStatus();
        }
    }, [loadStatus]);

    // Ручной клик "Синхронизировать сейчас" - в отличие от фонового тика,
    // показывает индикатор загрузки и блокирует повторный клик до ответа.
    const sync = useCallback(async () => {
        if (!statusRef.current?.connected || isSyncingRef.current) return;
        isSyncingRef.current = true;
        setIsSyncing(true);
        await runSync();
        isSyncingRef.current = false;
        setIsSyncing(false);
    }, [runSync]);

    useEffect(() => {
        loadStatus();
    }, [loadStatus]);

    // Следующий тик планируется только после завершения предыдущего
    // (setTimeout, не setInterval) - параллельных автосинков быть не может.
    useEffect(() => {
        let cancelled = false;
        let timeoutId: ReturnType<typeof setTimeout>;

        const tick = async () => {
            if (statusRef.current?.connected) {
                await runSync();
            }
            if (!cancelled) {
                timeoutId = setTimeout(tick, AUTO_SYNC_INTERVAL_MS);
            }
        };

        timeoutId = setTimeout(tick, AUTO_SYNC_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearTimeout(timeoutId);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { status, loading, isSyncing, sync, refresh: loadStatus, setStatus };
};
