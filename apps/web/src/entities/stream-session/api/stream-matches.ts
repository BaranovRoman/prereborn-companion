import { streamApiClient } from "@/entities/stream-user/api/stream-client";
import type {
    AccountStreamMatch,
    MatchCorrectionCommand,
    MatchCorrectionResponse,
} from "../model/types";

export const streamMatchesApi = {
    list: async (): Promise<AccountStreamMatch[]> => {
        const { data } = await streamApiClient.get<AccountStreamMatch[]>(
            "/account/me/matches"
        );
        return data;
    },

    patch: async (
        matchId: string,
        command: MatchCorrectionCommand
    ): Promise<MatchCorrectionResponse> => {
        const { data } = await streamApiClient.patch<MatchCorrectionResponse>(
            `/account/me/matches/${encodeURIComponent(matchId)}`,
            command
        );
        return data;
    },
};
