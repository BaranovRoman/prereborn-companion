use serde::Serialize;

// WK-111 - deliberately NOT a copy of the Postgres `stream_sessions`/
// `stream_matches` schema (apps/api/src/services/stream-session-service.ts,
// stream-match-service.ts). Only the fields the local runtime itself needs
// to detect/track a match and its MMR contribution locally, plus the
// minimum needed for a *future* sync step to identify rows - see the
// "sync_state"/"backend_id" comment on each struct below and
// docs/research/wk-110-local-first-audit.md §11.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    /// Never pushed to the backend. This is the only state WK-111 ever
    /// writes - no sync exists yet (see this module's doc comment). The
    /// column exists now purely as schema headroom for WK-113: adding a
    /// column later is a trivial migration, retrofitting stable ids onto
    /// rows that already exist is not.
    Pending,
}

impl Default for SyncState {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalMatchState {
    InProgress,
    PostGamePending,
    Finalized,
    NeedsReview,
    Interrupted,
}

impl LocalMatchState {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::InProgress => "in_progress",
            Self::PostGamePending => "post_game_pending",
            Self::Finalized => "finalized",
            Self::NeedsReview => "needs_review",
            Self::Interrupted => "interrupted",
        }
    }

    pub fn from_db_str(value: &str) -> Option<Self> {
        match value {
            "in_progress" => Some(Self::InProgress),
            "post_game_pending" => Some(Self::PostGamePending),
            "finalized" => Some(Self::Finalized),
            "needs_review" => Some(Self::NeedsReview),
            "interrupted" => Some(Self::Interrupted),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchResult {
    Win,
    Loss,
    Abandon,
}

impl MatchResult {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Win => "win",
            Self::Loss => "loss",
            Self::Abandon => "abandon",
        }
    }

    pub fn from_db_str(value: &str) -> Option<Self> {
        match value {
            "win" => Some(Self::Win),
            "loss" => Some(Self::Loss),
            "abandon" => Some(Self::Abandon),
            _ => None,
        }
    }
}

// WK-111, per the audit's explicit instruction (#9 in the follow-up scope):
// ranked/unranked is NOT guessable locally today - Companion has no local
// mirror of the account's `stream_users.game_mode` toggle (that setting
// lives only on the backend/web dashboard, see
// docs/research/wk-110-local-first-audit.md §2.3). Modeling this as
// `Option<bool>` defaulting to `None`/Unknown (never a fabricated `false`
// or `true`) is the explicit fix for "не угадывать" - a real value can only
// ever be populated by a future ticket that actually sources it (e.g. a
// synced-down copy of the toggle), never invented here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RankedMode {
    Unknown,
    Ranked,
    Unranked,
}

impl RankedMode {
    // No writer sets this to `Ranked`/`Unranked` yet (see this enum's doc
    // comment above) - kept for read/write symmetry with `from_db_str` and
    // reserved for the future ticket that sources the ranked/unranked
    // toggle locally, rather than leaving that writer with an inconsistent
    // one-way mapping to build against.
    #[allow(dead_code)]
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Ranked => "ranked",
            Self::Unranked => "unranked",
        }
    }

    pub fn from_db_str(value: &str) -> Self {
        match value {
            "ranked" => Self::Ranked,
            "unranked" => Self::Unranked,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalSession {
    pub local_id: String,
    pub backend_id: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub rating_start: Option<i64>,
    pub rating_current: Option<i64>,
    pub rating_adjustment: i64,
    // WK-112 - set the instant OBS reports "not streaming" for a session
    // that was open; cleared if streaming resumes within the grace window.
    // See `local_runtime::lifecycle`.
    pub pending_end_at: Option<String>,
    // WK-112 - true once the user has explicitly chosen "continue this
    // session" during stale-session manual recovery. See `lifecycle::is_stale`.
    pub stale_ack: bool,
    pub sync_state: SyncState,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalMatch {
    pub local_id: String,
    pub session_local_id: String,
    pub backend_id: Option<String>,
    /// GSI's own `map.matchid` when Dota provides one - used for the same
    /// "is this the same match" identity comparison the backend state
    /// machine uses (stream-match-service.ts's `sameMatch`), and available
    /// later as a natural correlation key for WK-113 sync/dedup against the
    /// backend's own `stream_matches.match_id`.
    pub match_id: Option<String>,
    /// Idempotency key: `gsi:<match_id>` when known, else a synthesized
    /// per-session/tick key - mirrors `stream-match-service.ts`'s
    /// `match_key`, enforced UNIQUE per session in the schema so a
    /// duplicate GSI snapshot or reconnect can never insert a second row
    /// for the same match.
    pub match_key: String,
    pub hero_id: i64,
    /// Team name observed at match start ("radiant"/"dire") - internal
    /// identity signal only (mirrors `stream-match-service.ts`'s
    /// `player_team`), never synced or shown anywhere.
    pub player_team: String,
    pub result: Option<MatchResult>,
    pub ranked_mode: RankedMode,
    pub rating_before: Option<i64>,
    pub detected_rating_delta: Option<i64>,
    pub rating_after: Option<i64>,
    pub state: LocalMatchState,
    pub started_at: String,
    pub interrupted_at: Option<String>,
    pub finalized_at: Option<String>,
    pub sync_state: SyncState,
}
