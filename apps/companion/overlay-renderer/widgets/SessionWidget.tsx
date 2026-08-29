import type { LocalSessionSummary } from "../types";

// WK-121 - "Session" widget: wins/losses + rating delta, ported visual
// language (dark engraved panel, gold accent numbers) from Companion's own
// existing Dota-like token system (App.css's --ui-* tokens), not a literal
// pixel copy of apps/web's SessionStats widget (that widget's exact layout
// depends on the user's saved OverlayLayout xVw/yVh/scale/anchor, which the
// local renderer does not have access to yet - see this slice's research
// doc, §"Remaining"). Renders nothing at all when there is no open local
// session, matching the source data's own `hasSession` flag.
export function SessionWidget({ session, big }: { session: LocalSessionSummary; big?: boolean }) {
  if (!session.hasSession) return null;
  const delta =
    session.ratingCurrent !== null && session.ratingStart !== null
      ? session.ratingCurrent - session.ratingStart
      : null;

  return (
    <div className={`ov-session ${big ? "ov-session--big" : ""}`}>
      <div className="ov-session__record">
        <span className="ov-session__wins">{session.wins}W</span>
        <span className="ov-session__sep">–</span>
        <span className="ov-session__losses">{session.losses}L</span>
      </div>
      {delta !== null && (
        <div className={`ov-session__delta ${delta >= 0 ? "is-positive" : "is-negative"}`}>
          {delta >= 0 ? "+" : ""}
          {delta} MMR
        </div>
      )}
    </div>
  );
}
