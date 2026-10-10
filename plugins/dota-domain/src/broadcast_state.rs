// WK-120 - canonical BroadcastState: ONE semantic answer to "what is the
// stream showing right now", extracted from what used to be entangled
// inside obs.rs's `resolve_desired_scene`. Two independent consumers read
// this:
//
//   - the OBS Scene Resolver (obs.rs), which maps it to a configured OBS
//     scene NAME and may apply its own downstream, OBS-specific fallback
//     (a mapped scene that doesn't exist in the user's OBS canvas -
//     `post_stream_unavailable`, see obs.rs) - that fallback has no meaning
//     for the overlay renderer, so it deliberately does NOT live here;
//   - the Local Overlay Runtime (overlay_server.rs), which serves this same
//     value to the OBS Browser Source with no OBS-specific knowledge at
//     all.
//
// Before this module existed, `obs.rs` computed this value for itself, and
// `apps/web`'s `getBroadcastScene`/`getActiveScene` (TypeScript) computed an
// equivalent value independently for the public web overlay - two
// hand-written implementations of one decision, confirmed as duplication in
// docs/research/wk-119-companion-primary-app-boundary-audit.md §1. This
// module removes that duplication on the LOCAL (Rust) side, where both real
// consumers now live; apps/web's resolver is intentionally left as-is (see
// docs/research/wk-120-local-overlay-runtime.md) since unifying it too would
// require piping this decision to the backend, out of scope for this slice.
//
// `resolve` reproduces `obs.rs`'s pre-WK-120 `resolve_desired_scene` (minus
// the OBS-specific `post_stream_unavailable` fallback, minus web's
// companion-offline draft-protection fallback which has no meaning here -
// see the module doc in docs/research/wk-120-local-overlay-runtime.md §2)
// byte-for-byte for the paths it covers, verified by obs.rs's own
// (unchanged) resolve_desired_scene test suite still passing against a thin
// wrapper around this module.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BroadcastState {
    BetweenMatches,
    Draft,
    Gameplay,
    // Never derived from GSI directly (see `from_gsi` below) - only ever
    // reached through `resolve`'s session-ended/manual-override precedence.
    PostStream,
}

impl BroadcastState {
    /// Pure GSI -> scene mapping. Identical field paths/logic to the
    /// pre-WK-120 `obs::BroadcastScene::from_gsi` (now a thin alias, see
    /// obs.rs) and to apps/web's `getBroadcastScene` - see
    /// docs/research/wk-119-companion-primary-app-boundary-audit.md §1.2 for
    /// the cross-reference between the two.
    pub fn from_gsi(payload: &Value) -> Self {
        let activity = payload.pointer("/player/activity").and_then(Value::as_str);
        if activity != Some("playing") {
            return Self::BetweenMatches;
        }
        match payload.pointer("/map/game_state").and_then(Value::as_str) {
            Some("DOTA_GAMERULES_STATE_HERO_SELECTION")
            | Some("DOTA_GAMERULES_STATE_STRATEGY_TIME")
            | Some("DOTA_GAMERULES_STATE_TEAM_SHOWCASE") => Self::Draft,
            Some("DOTA_GAMERULES_STATE_PRE_GAME")
            | Some("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS") => Self::Gameplay,
            _ => Self::BetweenMatches,
        }
    }
}

/// The one precedence rule this module owns: a locally-ended session or a
/// manual "Итоги стрима" pin both mean PostStream wins over whatever GSI
/// would otherwise show - mirrors the public web overlay's own
/// `getActiveScene` precedence (ended wins unconditionally over
/// GSI/override). Deliberately excludes:
///
///   - OBS-specific concerns (whether the mapped OBS scene physically
///     exists) - that's `obs.rs`'s own downstream adaptation of this value,
///     not part of what the stream canonically IS;
///   - web's companion-offline draft-protection fallback - meaningless here
///     since Rust computing this value IS Companion; if Companion is down,
///     nothing in this process runs at all (see the local-overlay-vs-legacy
///     tradeoff discussion in docs/research/wk-120-local-overlay-runtime.md).
pub fn resolve(gsi_derived: BroadcastState, session_ended: bool, manual_summary_override: bool) -> BroadcastState {
    if session_ended || manual_summary_override {
        BroadcastState::PostStream
    } else {
        gsi_derived
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn from_gsi_maps_known_states() {
        assert_eq!(
            BroadcastState::from_gsi(&json!({"map": {"game_state": "DOTA_GAMERULES_STATE_HERO_SELECTION"}, "player": {"activity": "playing"}})),
            BroadcastState::Draft
        );
        assert_eq!(
            BroadcastState::from_gsi(&json!({"map": {"game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS"}, "player": {"activity": "playing"}})),
            BroadcastState::Gameplay
        );
        assert_eq!(
            BroadcastState::from_gsi(&json!({"map": {"game_state": "DOTA_GAMERULES_STATE_POST_GAME"}, "player": {"activity": "playing"}})),
            BroadcastState::BetweenMatches
        );
    }

    // WK-120 acceptance: idle/between (no active match).
    #[test]
    fn idle_with_no_active_match_resolves_to_between_matches() {
        let gsi = BroadcastState::from_gsi(&json!({}));
        assert_eq!(gsi, BroadcastState::BetweenMatches);
        assert_eq!(resolve(gsi, false, false), BroadcastState::BetweenMatches);
    }

    // WK-120 acceptance: draft.
    #[test]
    fn draft_state_passes_through_when_session_is_active() {
        assert_eq!(resolve(BroadcastState::Draft, false, false), BroadcastState::Draft);
    }

    // WK-120 acceptance: gameplay.
    #[test]
    fn gameplay_state_passes_through_when_session_is_active() {
        assert_eq!(resolve(BroadcastState::Gameplay, false, false), BroadcastState::Gameplay);
    }

    // WK-120 acceptance: post-game (a finished match alone is NOT PostStream
    // - only a locally-ended SESSION is, a distinct signal).
    #[test]
    fn a_finished_match_alone_does_not_resolve_to_post_stream() {
        let post_game = BroadcastState::from_gsi(&json!({"map": {"game_state": "DOTA_GAMERULES_STATE_POST_GAME"}, "player": {"activity": "playing"}}));
        assert_eq!(resolve(post_game, false, false), BroadcastState::BetweenMatches);
    }

    // WK-120 acceptance: session end / PostStream.
    #[test]
    fn session_end_resolves_to_post_stream_regardless_of_the_gsi_derived_scene() {
        for gsi_derived in [BroadcastState::Gameplay, BroadcastState::Draft, BroadcastState::BetweenMatches, BroadcastState::PostStream] {
            assert_eq!(resolve(gsi_derived, true, false), BroadcastState::PostStream);
        }
    }

    // WK-120 acceptance: manual PostStream override ("Итоги стрима"),
    // independent of session_ended.
    #[test]
    fn manual_summary_override_resolves_to_post_stream_without_the_session_being_ended() {
        for gsi_derived in [BroadcastState::Gameplay, BroadcastState::Draft, BroadcastState::BetweenMatches] {
            assert_eq!(resolve(gsi_derived, false, true), BroadcastState::PostStream);
        }
    }

    // WK-120 acceptance: resume live (clearing the override lets the
    // GSI-derived scene back through).
    #[test]
    fn resume_live_lets_the_gsi_derived_scene_through_again() {
        assert_eq!(resolve(BroadcastState::Gameplay, false, false), BroadcastState::Gameplay);
    }

    // WK-120 acceptance: reconnect (GSI silence/timeout alone is not an
    // end-of-stream signal - from_gsi's fallback is BetweenMatches, same as
    // any other non-playing tick, and session_ended is a wholly separate
    // signal, never flipped by lost GSI on its own).
    #[test]
    fn lost_gsi_signal_alone_does_not_trigger_post_stream() {
        let desired = BroadcastState::from_gsi(&json!({}));
        assert_eq!(resolve(desired, false, false), BroadcastState::BetweenMatches);
    }

    // WK-120 acceptance: "OBS automation disabled" has no meaning at THIS
    // layer by design - resolve() never reads obs_config.enabled at all
    // (that gate lives one layer down, in obs.rs's schedule_switch, and
    // never in the canonical decision) - pinned here so a future change
    // can't accidentally couple them. The overlay renderer must keep
    // reflecting the real canonical state even when the user has turned off
    // OBS auto scene-switching (a purely cosmetic OBS-side preference, see
    // WK-116's regression note in obs.rs).
    #[test]
    fn resolve_has_no_obs_automation_enabled_parameter_at_all() {
        fn _type_check(gsi_derived: BroadcastState, session_ended: bool, manual_summary_override: bool) -> BroadcastState {
            resolve(gsi_derived, session_ended, manual_summary_override)
        }
        assert_eq!(resolve(BroadcastState::Gameplay, false, false), BroadcastState::Gameplay);
    }
}
