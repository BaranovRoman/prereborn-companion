// Compatibility adapter: real history queries and DTOs are owned by Dota.
pub use companion_dota_storage::local_runtime::summary::*;
use tauri::{AppHandle,Manager,Runtime};
use super::{LocalRuntimeState,store};
use crate::state::AppState;
fn log_history_load<R: Runtime>(app: &AppHandle<R>, count: usize, current_session: Option<&str>) {
    let signature = format!("{count}:{current_session:?}");
    let should_log = {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        if inner.last_history_log_signature.as_deref() == Some(&signature) {
            false
        } else {
            inner.last_history_log_signature = Some(signature);
            true
        }
    };
    if should_log {
        crate::storage::append_rolling_log(
            app,
            &format!("Local history loaded: matches={count} history_session_filter=none current_session={current_session:?}"),
        );
    }
}


pub fn get<R:Runtime>(app:&AppHandle<R>)->LocalSessionSummary {
 let state=app.state::<LocalRuntimeState>();let guard=state.lock();
 let Some(conn)=guard.as_ref()else{return LocalSessionSummary::default();};
 let summary=companion_dota_storage::local_runtime::summary::get(conn);
 let session=store::find_open_session(conn).ok().flatten().map(|s|s.local_id);
 log_history_load(app,summary.recent_matches.len(),session.as_deref());summary
}
pub fn hero_stats<R:Runtime>(app:&AppHandle<R>,hero_id:i64)->HeroLocalStats {
 let state=app.state::<LocalRuntimeState>();let guard=state.lock();
 match guard.as_ref(){Some(conn)=>companion_dota_storage::local_runtime::summary::hero_stats(conn,hero_id),None=>HeroLocalStats {matches:0,wins:0,losses:0,avg_kills:None,avg_deaths:None,avg_assists:None,recent_results:vec![]}}
}
