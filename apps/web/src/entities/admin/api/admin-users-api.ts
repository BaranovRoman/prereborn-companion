import { adminApiClient } from "./admin-client";
import type {
    AdminUserDetail,
    AdminUserListResult,
    AdminStreamSession,
} from "../model/types";

export const adminUsersApi = {
    list: async (params: {
        page: number;
        pageSize: number;
        query?: string;
    }): Promise<AdminUserListResult> => {
        const { data } = await adminApiClient.get<AdminUserListResult>("/users", {
            params: {
                page: params.page,
                pageSize: params.pageSize,
                q: params.query || undefined,
            },
        });
        return data;
    },

    getById: async (id: string): Promise<AdminUserDetail> => {
        const { data } = await adminApiClient.get<AdminUserDetail>(
            `/users/${id}`
        );
        return data;
    },

    endActiveSession: async (id: string): Promise<AdminStreamSession> => {
        const { data } = await adminApiClient.post<AdminStreamSession>(
            `/users/${id}/session/end`
        );
        return data;
    },

    resetOnboarding: async (
        id: string
    ): Promise<{ id: string; onboardingCompletedAt: string | null }> => {
        const { data } = await adminApiClient.post<{
            id: string;
            onboardingCompletedAt: string | null;
        }>(`/users/${id}/onboarding/reset`);
        return data;
    },
};
