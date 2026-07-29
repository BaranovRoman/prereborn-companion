import { streamApiClient } from "@/entities/stream-user/api/stream-client";

// Референс-скриншот HUD ("фон для примерки") хранится на backend (см.
// stream_overlay_reference_backgrounds) - отдельно от OverlayLayout, который
// эхом уходит в публичный /overlay/:token (см. reference-background-store.ts,
// удалённый вместе с переездом на этот API).
export interface ReferenceBackgroundDto {
    url: string;
    fileName: string;
    naturalWidth: number;
    naturalHeight: number;
    // 0..1
    opacity: number;
}

const ENDPOINT = "/account/me/overlay-reference-background";

export const referenceBackgroundApi = {
    get: async (): Promise<ReferenceBackgroundDto | null> => {
        const { data } = await streamApiClient.get<ReferenceBackgroundDto | null>(
            ENDPOINT
        );
        return data;
    },

    upload: async (file: File): Promise<ReferenceBackgroundDto> => {
        const formData = new FormData();
        formData.append("image", file);
        const { data } = await streamApiClient.post<ReferenceBackgroundDto>(
            ENDPOINT,
            formData
        );
        return data;
    },

    setOpacity: async (opacity: number): Promise<ReferenceBackgroundDto> => {
        const { data } = await streamApiClient.patch<ReferenceBackgroundDto>(
            ENDPOINT,
            { opacity }
        );
        return data;
    },

    remove: async (): Promise<void> => {
        await streamApiClient.delete(ENDPOINT);
    },
};
