// WK-189 - results of integration flows that end on the account page
// (?steam=, ?twitch=, ?donationAlerts= set by the API callbacks). Twitch and
// DonationAlerts are connected from Companion, so the notice sends the user
// back there.
type Params = Pick<URLSearchParams, "get">;

export type CallbackNotice = { tone: "success" | "error"; text: string };

const providers = [
  ["twitch", "Twitch", "Вернитесь в Companion — статус обновится сам."],
  ["donationAlerts", "DonationAlerts", "Вернитесь в Companion — статус обновится сам."],
  ["steam", "Steam", "Плагин Dota 2 в Companion подхватит привязку сам."],
] as const;

export const callbackNotice = (params: Params): CallbackNotice | null => {
  for (const [key, name, next] of providers) {
    const value = params.get(key);
    if (value === "connected") return { tone: "success", text: `${name} подключён. ${next}` };
    if (value === "error") {
      const taken = key === "steam" && params.get("reason") === "already_linked";
      return {
        tone: "error",
        text: taken
          ? "Этот Steam-аккаунт уже привязан к другому аккаунту Prereborn."
          : `Не удалось подключить ${name}. Попробуйте ещё раз${key === "steam" ? "" : " из Companion"}.`,
      };
    }
  }
  return null;
};
