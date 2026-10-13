//! The existing OBS-driven session rules, without database or transport access.
use chrono::{DateTime, Duration, Utc};
/// Grace period after OBS reports "not streaming" before a session is
/// actually ended - protects against a brief OBS/RTMP hiccup or a quick
/// OBS restart being mistaken for the end of the stream.
pub const GRACE_PERIOD: Duration = Duration::seconds(30);

/// An open session older than this is treated as ambiguous rather than
/// silently continued or silently ended - see `is_stale`.
pub const STALE_THRESHOLD: Duration = Duration::hours(12);

/// How often the sweep tick re-checks a pending-end session against the
/// grace period, so "OBS stopped and nothing else ever happens again"
/// still finalizes the session without needing a second OBS event.


#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct SessionLifecycleView {
    pub local_id: String,
    pub started_at: DateTime<Utc>,
    pub pending_end_at: Option<DateTime<Utc>>,
    pub stale_ack: bool,
    // WK-137 - false for a gameplay session GSI opened with no OBS stream
    // active. See docs/research/wk-137-match-session-decoupling.md.
    pub is_streamed: bool,
}


pub fn parse_rfc3339(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value).ok().map(|dt| dt.with_timezone(&Utc))
}

/// An open session is "stale" - too ambiguous to auto-continue or
/// auto-end - once it's older than `STALE_THRESHOLD` and the user hasn't
/// already confirmed it via manual recovery (`stale_ack`). Independent of
/// current OBS streaming truth by design: a days-old open session is
/// suspicious regardless of what OBS happens to be doing right now, and
/// this must stay readable (for the recovery-status UI) even when OBS
/// itself is unreachable - see `status` below.
pub fn is_stale(session: &SessionLifecycleView, now: DateTime<Utc>) -> bool {
    !session.stale_ack && now.signed_duration_since(session.started_at) > STALE_THRESHOLD
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all="snake_case")]
pub enum LifecycleDecision {
    NoOp,
    StartNewSession,
    ContinueSession,
    CancelPendingEnd,
    BeginPendingEnd,
    FinalizeEnd,
    FlagStaleForManualRecovery,
}

/// The one decision function this whole feature adds. Pure: local session
/// state + OBS's own streaming truth + current time in, one decision out -
/// no I/O, no backend/network type can be threaded into this signature by
/// construction. See `stream_lifecycle_never_depends_on_backend_state`.
pub fn decide(
    open_session: Option<&SessionLifecycleView>,
    streaming: bool,
    now: DateTime<Utc>,
) -> LifecycleDecision {
    decide_with(open_session, streaming, now, GRACE_PERIOD)
}

pub fn decide_with(
    open_session: Option<&SessionLifecycleView>,
    streaming: bool,
    now: DateTime<Utc>,
    grace: Duration,
) -> LifecycleDecision {
    let Some(session) = open_session else {
        return if streaming { LifecycleDecision::StartNewSession } else { LifecycleDecision::NoOp };
    };

    // WK-137 - staleness/manual-recovery is a stream-session concept only: a
    // gameplay session (`is_streamed = false`) is invisible bookkeeping the
    // user never manages through this UI (see `status` below, scoped to
    // streamed sessions), and flagging one stale here would wrongly block
    // it from ever graduating into a real stream if OBS starts streaming
    // after it's been open a long time (an abandoned/never-resolved match).
    if session.is_streamed && is_stale(session, now) {
        return LifecycleDecision::FlagStaleForManualRecovery;
    }

    // WK-137 - OBS reporting "not streaming" is the normal, expected state
    // for a gameplay session (nothing has gone live at all) and must never
    // start the pending-end countdown that only makes sense for a session
    // OBS itself opened - see `store::ensure_gameplay_session`'s doc
    // comment. `(true, ..)` still reaches `ContinueSession` for a gameplay
    // session too, which is what lets it graduate (`apply`'s
    // `mark_session_streamed` call) instead of restarting from scratch.
    match (streaming, session.pending_end_at, session.is_streamed) {
        (true, Some(_), _) => LifecycleDecision::CancelPendingEnd,
        (true, None, _) => LifecycleDecision::ContinueSession,
        (false, _, false) => LifecycleDecision::NoOp,
        (false, None, true) => LifecycleDecision::BeginPendingEnd,
        (false, Some(pending_since), true) => {
            if now.signed_duration_since(pending_since) >= grace {
                LifecycleDecision::FinalizeEnd
            } else {
                LifecycleDecision::NoOp
            }
        }
    }
}
