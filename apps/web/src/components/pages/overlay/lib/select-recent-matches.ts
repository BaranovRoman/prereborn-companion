import type { RecentMatchesSettings } from "@/entities/stream-overlay-layout/model/types";
import type { OverlayData, StreamMatch } from "@/entities/stream-session/model/types";

export const selectRecentMatches = (
    data: Pick<OverlayData, "matches" | "recentMatches">,
    source: RecentMatchesSettings["source"]
): StreamMatch[] =>
    source === "recent-matches" ? (data.recentMatches ?? []) : data.matches;
