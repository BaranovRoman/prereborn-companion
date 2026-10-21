// WK-189 - the old stream settings cabinet is gone; its settings live in
// Companion. /stream stays a valid address because Companion's "Привязать
// Steam" opens it and older OAuth callbacks land on it, so the query string
// (?steam=, ?twitch=, ?donationAlerts=) is carried over to /account.
export type LegacySearchParams = Record<string, string | string[] | undefined>;

export const toAccountUrl = (query: LegacySearchParams = {}): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
  }
  const search = params.toString();
  return search ? `/account?${search}` : "/account";
};
