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

// Ответ POST /account/me/companion-token/regenerate - единственное место,
// где сырой токен вообще появляется на клиенте. Не сохраняется нигде,
// кроме показа пользователю один раз (companion-panel.tsx).
export interface RegenerateCompanionTokenResult {
    token: string;
    companionTokenCreatedAt: string;
}

export interface StreamAuthResponse {
    user: StreamUser;
    accessToken: string;
    refreshToken: string;
}
