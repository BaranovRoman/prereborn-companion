import { adminApiClient } from "./admin-client";
import type {
    AdminUsageStats,
    AdminUserDetail,
    AdminUserListResult,
    AdminUserSort,
    AdminStreamSession,
} from "../model/types";

export const adminUsersApi = {
    list: async (params: {
        page: number;
        pageSize: number;
        query?: string;
        sort?: AdminUserSort;
    }): Promise<AdminUserListResult> => {
        const { data } = await adminApiClient.get<AdminUserListResult>("/users", {
            params: {
                page: params.page,
                pageSize: params.pageSize,
                q: params.query || undefined,
                sort: params.sort,
            },
        });
        return data;
    },

    usageStats: async (): Promise<AdminUsageStats> => {
        const { data } = await adminApiClient.get<AdminUsageStats>("/usage-stats");
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

    // WK-192 - executes an emailed deletion request; confirmEmail must repeat
    // the target's email (server-side guard against a wrong id).
    deleteUser: async (id: string, confirmEmail: string): Promise<void> => {
        await adminApiClient.delete(`/users/${id}`, { data: { confirmEmail } });
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
