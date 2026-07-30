import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type { QueueSettings } from "../model/types";

export const queueWebcamImageApi = {
    upload: async (file: File): Promise<QueueSettings> => {
        const formData = new FormData();
        formData.append("image", file);
        const { data } = await streamApiClient.post<{
            webcamImageUrl: string;
            settings: QueueSettings;
        }>("/account/me/queue-webcam-image", formData);
        return data.settings;
    },
    remove: async (): Promise<void> => {
        await streamApiClient.delete("/account/me/queue-webcam-image");
    },
};
