//! Real store algorithms on a caller-owned transaction.
//! Never commits or opens connections; the host retains the write coordinator.
use chrono::{DateTime, Utc};
use rusqlite::Transaction;

use super::{
    gsi::MatchTelemetry,
    model::{LocalMatch, LocalSession, MatchResult, RankedMode},
    store, sync,
};

pub struct Facade<'a, 'c> {
    tx: &'a Transaction<'c>,
}

impl<'a, 'c> Facade<'a, 'c> {
    pub fn new(tx: &'a Transaction<'c>) -> Self {
        Self { tx }
    }

    pub fn session(&self, now: DateTime<Utc>, streamed: bool) -> rusqlite::Result<LocalSession> {
        match store::find_open_session(self.tx)? {
            Some(session) => Ok(session),
            None => store::insert_session_in(self.tx, now, streamed),
        }
    }

    pub fn streamed(&self, id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
        store::mark_session_streamed_in(self.tx, id, now)
    }

    pub fn rating(&self, rating: i64) -> rusqlite::Result<Option<LocalSession>> {
        store::set_current_rating_in(self.tx, rating)
    }

    pub fn end_session(&self, id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
        store::finalize_session_end_in(self.tx, id, now)
    }

    pub fn create_match(
        &self,
        session: &str,
        game: Option<&str>,
        hero: i64,
        team: &str,
        mode: RankedMode,
        now: DateTime<Utc>,
    ) -> rusqlite::Result<()> {
        store::create_match(self.tx, session, game, hero, team, mode, now)
    }

    pub fn resume(&self, id: &str, game: Option<&str>, hero: i64) -> rusqlite::Result<()> {
        store::resume_match(self.tx, id, game, hero)
    }

    pub fn telemetry(&self, id: &str, data: &MatchTelemetry, now: DateTime<Utc>) -> rusqlite::Result<()> {
        store::update_match_telemetry(self.tx, id, data, now)
    }

    pub fn interrupted(&self, id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
        store::mark_interrupted(self.tx, id, now)
    }

    pub fn needs_review(&self, id: &str) -> rusqlite::Result<()> {
        store::mark_needs_review(self.tx, id)
    }

    pub fn post_game(&self, id: &str, result: Option<MatchResult>) -> rusqlite::Result<()> {
        store::set_post_game(self.tx, id, result)
    }

    pub fn finish(
        &self,
        id: &str,
        session: &str,
        mode: RankedMode,
        result: MatchResult,
        confidence: &str,
        now: DateTime<Utc>,
    ) -> rusqlite::Result<()> {
        store::finalize_match_in(self.tx, id, session, mode, result, confidence, now)
    }

    pub fn correct_delta(&self, id: &str, delta: Option<i64>) -> rusqlite::Result<Option<LocalMatch>> {
        store::correct_match_delta_in(self.tx, id, delta)
    }

    pub fn correct_mode(&self, id: &str, mode: Option<RankedMode>) -> rusqlite::Result<Option<LocalMatch>> {
        store::correct_match_ranked_mode_in(self.tx, id, mode)
    }

    pub fn server_correction(
        &self,
        id: &str,
        delta: i64,
        after: Option<i64>,
        session_rating: Option<i64>,
        adjustment: Option<i64>,
    ) -> rusqlite::Result<()> {
        sync::apply_one_correction(self.tx, id, delta, after, session_rating, adjustment)
    }

    pub fn enqueue(
        &self,
        kind: &str,
        id: &str,
        event: &str,
        payload: &serde_json::Value,
        now: DateTime<Utc>,
    ) -> rusqlite::Result<()> {
        sync::enqueue(self.tx, kind, id, event, payload, now)
    }

    pub fn outbox_status(&self) -> rusqlite::Result<sync::SyncOutboxStatus> {
        sync::outbox_status(self.tx)
    }
    pub fn lookup_active(&self,session:&str)->rusqlite::Result<Option<LocalMatch>> {store::find_active_match(self.tx,session)}
    pub fn lookup_match(&self,id:&str)->rusqlite::Result<Option<LocalMatch>> {store::find_match(self.tx,id)}
    pub fn lookup_key(&self,session:&str,key:&str)->rusqlite::Result<Option<LocalMatch>> {store::diagnostic_find_key(self.tx,session,key)}
    pub fn lookup_session(&self,id:&str)->rusqlite::Result<Option<LocalSession>> {store::find_session(self.tx,id)}

}

/// Shared legacy/adapter transaction boundary; no new connection or coordinator.
pub(super) fn with_transaction<T>(conn:&mut rusqlite::Connection,write:impl FnOnce(&rusqlite::Transaction<'_>)->rusqlite::Result<T>)->rusqlite::Result<T> {
    let tx=conn.transaction()?;let result=write(&tx)?;tx.commit()?;Ok(result)
}
