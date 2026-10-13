//! Match decisions only. No store, UUID generation, clock reads, transport or effects.
use chrono::{DateTime, Duration, Utc};
use serde::{Serialize, Deserialize};
use crate::{gsi::{self, GsiSnapshot}, model::{LocalMatchState, MatchResult, RankedMode}, contracts::ReplayGsi};

pub const STALE_THRESHOLD: Duration = Duration::minutes(20);
const RECONNECT_WINDOW: Duration = Duration::minutes(5);
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct MatchContext {
    pub local_id: String, pub session_local_id: String, pub match_id: Option<String>,
    pub player_team: String, pub state: LocalMatchState, pub result: Option<MatchResult>,
    pub ranked_mode: RankedMode, pub interrupted_at: Option<String>,
    pub started_at: String, pub last_seen_at: Option<String>,
    // Legacy has no persisted revision column: never invent one.
    pub revision: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct SessionContext { pub local_id:String, pub ended:bool, pub streamed:bool }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Context {
    pub frame_sequence:u64, pub snapshot_identity:String, pub captured_at:DateTime<Utc>,
    pub active:Option<MatchContext>, pub session:SessionContext, pub ranked_mode:RankedMode,
    pub inconclusive_reason:Option<String>,
    /// Host-injected fallback preserves legacy's malformed-timestamp behavior; shadow is inconclusive.
    pub timestamp_fallback:DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag="operation", rename_all="snake_case", deny_unknown_fields)]
pub enum Action {
    UpdateTelemetry { local_id:String },
    Interrupted { local_id:String }, NeedsReview { local_id:String },
    Pending { local_id:String, result:Option<MatchResult> },
    Finalize { local_id:String, session_local_id:String, ranked_mode:RankedMode, result:MatchResult, confidence:String },
    Resume { local_id:String, game_match_id:Option<String>, hero_id:i64 },
    // Conditional store lookup preserves legacy INSERT OR IGNORE/race semantics.
    EnsureMatch { game_match_id:Option<String>, hero_id:i64, player_team:String, ranked_mode:RankedMode },
    UpdateCurrentTelemetry,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Decision { pub actions:Vec<Action>, pub evidence:String, pub end_gameplay_session:bool }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct WatchdogDecision { pub stale:bool, pub auto_interrupt:bool, pub local_id:Option<String>, pub evidence:String }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Analysis { pub conclusive:bool, pub reason:Option<String>, pub detector:Option<Decision>, pub watchdog:Option<WatchdogDecision> }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaveDecision { MarkInterrupted, FinalizeProbable, MarkNeedsReview, NoOp }
pub fn decide_leave(state:LocalMatchState,result:Option<MatchResult>)->LeaveDecision {
    match state {
        LocalMatchState::InProgress=>LeaveDecision::MarkInterrupted,
        LocalMatchState::PostGamePending=>if result.is_some(){LeaveDecision::FinalizeProbable}else{LeaveDecision::MarkNeedsReview},
        LocalMatchState::Interrupted|LocalMatchState::Finalized|LocalMatchState::NeedsReview=>LeaveDecision::NoOp,
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostGameDecision { TransitionToPending(Option<MatchResult>), SetFirstObservation(MatchResult), FinalizeConfirmed, MarkNeedsReview, NoOp }
pub fn decide_post_game(state:LocalMatchState,current:Option<MatchResult>,observation:Option<MatchResult>)->PostGameDecision {
    match state {
        LocalMatchState::InProgress=>PostGameDecision::TransitionToPending(observation),
        LocalMatchState::PostGamePending=>match(current,observation){(_,None)=>PostGameDecision::NoOp,(None,Some(r))=>PostGameDecision::SetFirstObservation(r),(Some(a),Some(b)) if a==b=>PostGameDecision::FinalizeConfirmed,(Some(_),Some(_))=>PostGameDecision::MarkNeedsReview},
        _=>PostGameDecision::NoOp,
    }
}
pub fn parse_time(raw:&str)->Option<DateTime<Utc>> { DateTime::parse_from_rfc3339(raw).ok().map(|t|t.with_timezone(&Utc)) }
pub fn is_same_match(active:&MatchContext,snapshot:&GsiSnapshot,now:DateTime<Utc>,fallback:DateTime<Utc>)->bool {
    match(&snapshot.match_id,&active.match_id) {
        (Some(a),Some(b))=>a==b,
        _=>snapshot.team_name.as_deref()==Some(active.player_team.as_str())
            && active.interrupted_at.as_deref().is_none_or(|raw| now-parse_time(raw).unwrap_or(fallback)<=RECONNECT_WINDOW)
            && (active.interrupted_at.is_none()||!gsi::is_new_match_signal_game_state(&snapshot.game_state)),
    }
}
pub fn is_new_match_evidence(snapshot:&GsiSnapshot)->bool {
    if !snapshot.is_match_lifecycle_tick()||snapshot.custom_game_name.is_some()||snapshot.is_post_game(){return false;}
    match snapshot.hero_id {Some(hero) if hero>0=>snapshot.team_name.is_some(),_=>false}
}
pub fn is_match_stale(last:DateTime<Utc>,now:DateTime<Utc>)->bool {now.signed_duration_since(last)>=STALE_THRESHOLD}
pub fn should_end_gameplay(streamed:bool,terminal:bool)->bool { terminal&&!streamed }
pub fn sweep_eligible(state:LocalMatchState,last_seen:Option<&str>,session_ended:bool,now:DateTime<Utc>)->bool {
    let cutoff=(now-STALE_THRESHOLD).to_rfc3339();
    matches!(state,LocalMatchState::InProgress|LocalMatchState::PostGamePending) && session_ended && last_seen.is_some_and(|last|last<=cutoff.as_str())
}
pub fn watchdog(context:&Context)->WatchdogDecision {
    let Some(active)=&context.active else {return WatchdogDecision{stale:false,auto_interrupt:false,local_id:None,evidence:"no_active_match".into()};};
    let stale=active.last_seen_at.as_deref().and_then(parse_time).is_some_and(|last|is_match_stale(last,context.captured_at));
    // Preserve the real store's lexical RFC3339 cutoff, including NULL semantics.
    let auto_interrupt=sweep_eligible(active.state,active.last_seen_at.as_deref(),context.session.ended,context.captured_at);
    WatchdogDecision{stale,auto_interrupt,local_id:Some(active.local_id.clone()),evidence:if auto_interrupt{"session_ended_and_sql_cutoff"}else if stale{"silence_only_no_effect"}else{"fresh_or_missing_time"}.into()}
}
pub fn decide(context:&Context,snapshot:&GsiSnapshot)->Decision {
    let mut actions=Vec::new();let mut evidence="no_op";
    let active=context.active.as_ref();
    let finalize=|a:&MatchContext,confidence:&str|Action::Finalize{local_id:a.local_id.clone(),session_local_id:a.session_local_id.clone(),ranked_mode:a.ranked_mode,result:a.result.unwrap(),confidence:confidence.into()};
    if !snapshot.is_match_lifecycle_tick()||snapshot.custom_game_name.is_some() {
        evidence="left_match";
        if let Some(a)=active {match decide_leave(a.state,a.result){
            LeaveDecision::MarkInterrupted=>actions.push(Action::Interrupted{local_id:a.local_id.clone()}),
            LeaveDecision::FinalizeProbable=>actions.push(finalize(a,"probable")),
            LeaveDecision::MarkNeedsReview=>actions.push(Action::NeedsReview{local_id:a.local_id.clone()}),LeaveDecision::NoOp=>(),
        }}
    } else if snapshot.is_post_game() {
        evidence="post_game";
        if let Some(a)=active {
            actions.push(Action::UpdateTelemetry{local_id:a.local_id.clone()});
            if matches!((&snapshot.match_id,&a.match_id),(Some(observed),Some(tracked)) if observed!=tracked) {
                evidence="post_game_identity_conflict";actions.push(Action::NeedsReview{local_id:a.local_id.clone()});
            } else {
                let observation=match snapshot.win_team.as_deref(){Some("radiant")|Some("dire")=>Some(if snapshot.win_team.as_deref()==Some(a.player_team.as_str()){MatchResult::Win}else{MatchResult::Loss}),_=>None};
                match decide_post_game(a.state,a.result,observation) {
                    PostGameDecision::TransitionToPending(result)=>actions.push(Action::Pending{local_id:a.local_id.clone(),result}),
                    PostGameDecision::SetFirstObservation(result)=>actions.push(Action::Pending{local_id:a.local_id.clone(),result:Some(result)}),
                    PostGameDecision::FinalizeConfirmed=>actions.push(finalize(a,"confirmed")),
                    PostGameDecision::MarkNeedsReview=>{evidence="conflicting_post_game_evidence";actions.push(Action::NeedsReview{local_id:a.local_id.clone()});},PostGameDecision::NoOp=>(),
                }
            }
        }
    } else if let (Some(hero),Some(team))=(snapshot.hero_id,snapshot.team_name.as_ref()) {
        if hero>0 {
            evidence="new_match";
            if let Some(a)=active {
                if is_same_match(a,snapshot,context.captured_at,context.timestamp_fallback) {
                    evidence="same_match_resume";actions.push(Action::Resume{local_id:a.local_id.clone(),game_match_id:snapshot.match_id.clone(),hero_id:hero});
                } else if is_match_stale(parse_time(a.last_seen_at.as_deref().unwrap_or(&a.started_at)).unwrap_or(context.timestamp_fallback),context.captured_at) {
                    evidence="distinct_match_after_stale";actions.push(Action::Interrupted{local_id:a.local_id.clone()});
                } else {evidence="distinct_match_needs_review";actions.push(Action::NeedsReview{local_id:a.local_id.clone()});}
            }
            actions.push(Action::EnsureMatch{game_match_id:snapshot.match_id.clone(),hero_id:hero,player_team:team.clone(),ranked_mode:context.ranked_mode});
            actions.push(Action::UpdateCurrentTelemetry);
        }
    }
    let terminal=matches!(actions.last(),Some(Action::Finalize{..}|Action::NeedsReview{..}));
    Decision{actions,evidence:evidence.into(),end_gameplay_session:should_end_gameplay(context.session.streamed,terminal)}
}
pub fn snapshot_identity(snapshot:&ReplayGsi)->String {
    use sha2::{Digest,Sha256};format!("{:x}",Sha256::digest(serde_json::to_vec(snapshot).unwrap()))
}
pub fn analyze(context:&Context,snapshot:&ReplayGsi,sequence:u64)->Analysis {
    let invalid= context.inconclusive_reason.as_ref().is_some_and(|r|r.len()>64)
        || context.frame_sequence!=sequence || context.snapshot_identity!=snapshot_identity(snapshot)
        || context.snapshot_identity.len()!=64 || context.session.local_id.len()>128
        || context.active.as_ref().is_some_and(|a|a.local_id.len()>128||a.session_local_id!=context.session.local_id||a.player_team.len()>128||a.match_id.as_ref().is_some_and(|id|id.len()>128)
            || [a.started_at.as_str()].into_iter().chain(a.last_seen_at.as_deref()).chain(a.interrupted_at.as_deref()).any(|t|t.len()>128||parse_time(t).is_none()));
    let reason=if invalid{Some("invalid_or_unbound_context".into())}else{context.inconclusive_reason.clone()};
    if reason.is_some(){return Analysis{conclusive:false,reason,detector:None,watchdog:None};}
    let value=serde_json::to_value(snapshot).unwrap();
    Analysis{conclusive:true,reason:None,detector:gsi::parse(&value).map(|s|decide(context,&s)),watchdog:Some(watchdog(context))}
}

impl Analysis {
    /// Bound typed replies as well as the outer IPC frame before diagnostic exposure.
    pub fn is_bounded(&self)->bool {
        self.reason.as_ref().is_none_or(|r|r.len()<=64)
            && self.watchdog.as_ref().is_none_or(|w|w.evidence.len()<=64&&w.local_id.as_ref().is_none_or(|id|id.len()<=128))
            && self.detector.as_ref().is_none_or(|d|d.evidence.len()<=64&&d.actions.len()<=8&&d.actions.iter().all(|a|match a {
                Action::UpdateTelemetry{local_id}|Action::Interrupted{local_id}|Action::NeedsReview{local_id}|Action::Pending{local_id,..}=>local_id.len()<=128,
                Action::Finalize{local_id,session_local_id,confidence,..}=>local_id.len()<=128&&session_local_id.len()<=128&&confidence.len()<=16,
                Action::Resume{local_id,game_match_id,..}=>local_id.len()<=128&&game_match_id.as_ref().is_none_or(|id|id.len()<=128),
                Action::EnsureMatch{game_match_id,player_team,..}=>game_match_id.as_ref().is_none_or(|id|id.len()<=128)&&player_team.len()<=128,
                Action::UpdateCurrentTelemetry=>true,
            }))
    }
}
