use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::state::{AppState, DEFAULT_BACKEND_URL};

// WK-148 - background refresh for Between Matches OpenDota enrichment
// (favorite-hero lifetime/patch line + "ПРОФИЛЬ ИГРОКА" радар) on the LOCAL
// renderer (127.0.0.1:3666/overlay). That renderer is plain browser code
// served over loopback HTTP+SSE (see overlay_server.rs) - it is NOT a Tauri
// webview and has no `invoke()`/IPC access, so it cannot call the same
// Companion IPC commands Hero Detail uses (get_hero_opendota_insights /
// get_account_opendota_radar in backend/mod.rs). Instead, this module polls
// apps/api directly on a timer and writes results into InnerState under
// lock; overlay_server.rs's snapshot builder (`current()`) reads them back
// synchronously - the local renderer itself never waits on OpenDota (задача,
// секция 5: "The overlay must NEVER wait synchronously on a cold OpenDota
// request before it can render").
//
// Mirrors backend::init's own std::thread::spawn + sleep-loop shape - the
// only background-task pattern this crate uses (no tokio interval anywhere).
// 90s is well inside apps/api's 10-minute OpenDota cache TTL, so most ticks
// just re-read a warm cache server-side rather than triggering a fresh
// OpenDota request - see opendota-hero-insights-cache-service.ts/
// opendota-account-insights-cache-service.ts.
const OPENDOTA_OVERLAY_POLL_INTERVAL: Duration = Duration::from_secs(90);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

pub fn init(app: AppHandle) {
    std::thread::spawn(move || loop {
        refresh(&app);
        std::thread::sleep(OPENDOTA_OVERLAY_POLL_INTERVAL);
    });
}

// Pulled out as a pure function (no AppState/lock involved) so the parsing
// logic - the only non-trivial logic in this module, the rest is plain HTTP
// plumbing already covered by this codebase's "no test for the real
// network-calling fetch fn" precedent (see get_hero_opendota_stats in
// backend/mod.rs) - is directly unit-testable.
fn extract_favorite_hero_ids(queue_settings: Option<&serde_json::Value>) -> Vec<i64> {
    queue_settings
        .and_then(|settings| settings.get("favoriteHeroIds"))
        .and_then(|value| value.as_array())
        .map(|ids| ids.iter().filter_map(|id| id.as_i64()).collect::<Vec<i64>>())
        .unwrap_or_default()
}

fn refresh(app: &AppHandle) {
    let (token, favorite_hero_ids) = {
        let state = app.state::<AppState>();
        let inner = state.0.lock().unwrap();
        let token = inner.companion_token.clone();
        let favorite_hero_ids = extract_favorite_hero_ids(inner.queue_settings.as_ref());
        (token, favorite_hero_ids)
    };
    // Not linked to a Companion session at all - nothing to enrich yet, and
    // no point recording this as a connectivity failure (it isn't one).
    let Some(token) = token else { return };

    // Empty selection (nothing manually pinned yet) - leave any previously
    // cached bundle in place rather than clearing it; a stale bundle keyed to
    // heroes no longer favorited is simply never looked up by heroId, so it
    // is harmless, and this avoids a request with an empty heroIds list.
    if !favorite_hero_ids.is_empty() {
        if let Ok(value) = fetch_favorite_heroes(&token, &favorite_hero_ids) {
            let state = app.state::<AppState>();
            state.0.lock().unwrap().opendota_favorite_heroes = Some(value);
        }
        // A failed fetch (OpenDota rate-limited/down, network hiccup) simply
        // skips this tick - the previous value (if any) stays put, and the
        // next tick tries again. No error surfaced anywhere (задача, секция
        // 12 - "OpenDota outage must simply remove external enrichment").
    }

    if let Ok(value) = fetch_radar(&token) {
        let state = app.state::<AppState>();
        state.0.lock().unwrap().opendota_radar = Some(value);
    }
}

fn fetch_favorite_heroes(token: &str, hero_ids: &[i64]) -> Result<serde_json::Value, String> {
    let ids_param = hero_ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?
        .get(format!(
            "{DEFAULT_BACKEND_URL}/stream/integrations/opendota/favorite-heroes?heroIds={ids_param}"
        ))
        .bearer_auth(token)
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response.json().map_err(|error| error.to_string())
}

fn fetch_radar(token: &str) -> Result<serde_json::Value, String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?
        .get(format!(
            "{DEFAULT_BACKEND_URL}/stream/integrations/opendota/profile-radar"
        ))
        .bearer_auth(token)
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Backend ответил {}", response.status()));
    }
    response.json().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_favorite_hero_ids_from_the_cached_queue_settings_blob() {
        let settings = serde_json::json!({ "favoriteHeroIds": [14, 26, 83] });
        assert_eq!(extract_favorite_hero_ids(Some(&settings)), vec![14, 26, 83]);
    }

    #[test]
    fn returns_an_empty_list_when_nothing_is_cached_yet() {
        assert_eq!(extract_favorite_hero_ids(None), Vec::<i64>::new());
    }

    #[test]
    fn returns_an_empty_list_when_favorite_hero_ids_is_absent_or_not_an_array() {
        assert_eq!(extract_favorite_hero_ids(Some(&serde_json::json!({}))), Vec::<i64>::new());
        assert_eq!(
            extract_favorite_hero_ids(Some(&serde_json::json!({ "favoriteHeroIds": "not-an-array" }))),
            Vec::<i64>::new()
        );
    }

    #[test]
    fn drops_non_numeric_entries_rather_than_failing_the_whole_list() {
        let settings = serde_json::json!({ "favoriteHeroIds": [14, "oops", 83] });
        assert_eq!(extract_favorite_hero_ids(Some(&settings)), vec![14, 83]);
    }
}
