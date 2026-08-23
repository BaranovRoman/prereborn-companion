// WK-84: единственная точка правды о том, относится ли матч из общей
// истории (Recent Games на dashboard / Between Matches) к текущей активной
// stream-сессии - используется только для visual-различения (opacity), не
// для W/L и рейтинга (это уже считает backend по тому же stream_session_id,
// см. stream-match-service.ts). Неизвестные данные (matchSessionId или
// activeSessionId отсутствуют) намеренно трактуются как "текущая" - список
// не должен тускнеть из-за неполной/ещё не загруженной информации.
export const isMatchFromCurrentSession = (
    matchSessionId: string | null | undefined,
    activeSessionId: string | null | undefined
): boolean => {
    if (!activeSessionId || !matchSessionId) return true;
    return matchSessionId === activeSessionId;
};
