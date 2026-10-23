export type StreamGameMode = "ranked" | "unranked";

export interface StreamUser {
    id: string;
    email: string;
    publicToken: string;
    createdAt: string;
    updatedAt: string;
    // Companion (apps/dota-companion) token - метаданные, сырой токен сюда
    // никогда не попадает (см. RegenerateCompanionTokenResult).
    companionTokenConfigured: boolean;
    companionTokenCreatedAt: string | null;
    // Текущий режим матчей ("что применится к СЛЕДУЮЩЕМУ завершённому
    // матчу") - см. PATCH /account/me/game-mode.
    gameMode: StreamGameMode;
    onboardingCompletedAt: string | null;
}

// GET /account/me also says whether the account is on the admin allowlist -
// only used to show the /admin link; the backend guards /api/admin itself.
export interface AccountUser extends StreamUser {
    isAdmin: boolean;
    // WK-191 - user agreement acceptance; acceptanceRequired is true for
    // accounts that haven't accepted the edition in force.
    terms?: TermsStatus | null;
}

export interface TermsStatus {
    currentVersion: string | null;
    acceptedVersion: string | null;
    acceptedAt: string | null;
    acceptanceRequired: boolean;
}

export interface StreamAuthResponse {
    user: StreamUser;
    accessToken: string;
    refreshToken: string;
}
