"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    referenceBackgroundApi,
    type ReferenceBackgroundDto,
} from "./reference-background-api";

// Debounce для setOpacity - Slider дёргает onChange на каждый тик драга,
// а backend-запрос (в отличие от прежней записи в IndexedDB) стоит сетевого
// похода - копим последнее значение и отправляем один раз через паузу.
const OPACITY_SAVE_DEBOUNCE_MS = 400;

// Управляет "фоном для примерки" - редактор просто читает record/imageUrl и
// вызывает upload/remove/setOpacity, не зная про backend-эндпоинт напрямую
// (см. reference-background-api.ts). Раньше хранилось в IndexedDB
// (см. историю reference-background-store.ts), теперь на сервере -
// публичный интерфейс хука не изменился, чтобы не трогать index.tsx.
export const useReferenceBackground = () => {
    const [record, setRecord] = useState<ReferenceBackgroundDto | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const opacityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        let cancelled = false;
        referenceBackgroundApi
            .get()
            .then((loaded) => {
                if (!cancelled) setRecord(loaded);
            })
            .catch(() => {
                // Сеть/backend недоступны - фон для примерки просто не
                // восстановится в этот раз, остальной редактор остаётся
                // полностью рабочим.
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(
        () => () => {
            if (opacityTimerRef.current) clearTimeout(opacityTimerRef.current);
        },
        []
    );

    const upload = useCallback(async (file: File) => {
        setError(null);
        try {
            const next = await referenceBackgroundApi.upload(file);
            setRecord(next);
        } catch {
            setError("Не удалось загрузить изображение");
        }
    }, []);

    const remove = useCallback(async () => {
        setError(null);
        const previous = record;
        setRecord(null);
        try {
            await referenceBackgroundApi.remove();
        } catch {
            setRecord(previous);
            setError("Не удалось удалить изображение");
        }
    }, [record]);

    const setOpacity = useCallback((opacity: number) => {
        setRecord((current) => (current ? { ...current, opacity } : current));

        if (opacityTimerRef.current) clearTimeout(opacityTimerRef.current);
        opacityTimerRef.current = setTimeout(() => {
            void referenceBackgroundApi.setOpacity(opacity);
        }, OPACITY_SAVE_DEBOUNCE_MS);
    }, []);

    return {
        record,
        imageUrl: record?.url ?? null,
        loading,
        error,
        upload,
        remove,
        setOpacity,
    };
};
