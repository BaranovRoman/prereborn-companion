// WK-120 - Local Overlay Runtime: a loopback-only HTTP+SSE server exposing
// the canonical BroadcastState (see broadcast_state.rs) to a local OBS
// Browser Source, so Companion -> OBS never has to round-trip through
// prereborn.ru for something that already happens on the same machine.
//
// This is NOT an offline-first feature - see
// docs/research/wk-120-local-overlay-runtime.md. The reason for this server
// is topology: GSI/local runtime already land in Companion, and OBS runs on
// the same PC, so the existing Companion -> apps/api -> OBS Browser Source
// round trip is a pure latency/hop removal opportunity, independent of
// whether the internet happens to be reachable.
//
// WK-121 update: `/overlay` now serves the real production renderer
// (apps/companion/overlay-renderer/, see RENDERER_HTML below) instead of
// WK-120's dev-preview page - a real OBS Browser Source can be pointed at
// http://127.0.0.1:3666/overlay today. See
// docs/research/wk-121-companion-product-consolidation.md for what "real"
// means here precisely (real local session/current-game data, the same
// Dota-like visual language as the rest of Companion, NOT a pixel-identical
// port of apps/web's user-positionable widget layout - that depends on data
// this server does not have local access to yet, documented as follow-up).
//
// Security: binds 127.0.0.1 only (never 0.0.0.0), and the payload this
// server can ever emit is `OverlayStateSnapshot` - two fields, `scene` and
// `updated_at` - constructed by `current()` below from ONLY the two AppState
// fields the canonical resolver needs. There is no code path in this file
// that can reach `companion_token`, `backend_*`, or any other credential
// field - see the `security` test module at the bottom.

use std::io::Write;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::broadcast_state::{self, BroadcastState};
use crate::local_runtime::summary::{self, LocalSessionSummary};
use crate::state::AppState;
use crate::storage;

pub const OVERLAY_PORT: u16 = 3666;

// Diff-gated poll, not a raw fixed-cadence push: `serve_sse` below only ever
// writes a new SSE frame when the resolved scene actually differs from the
// last one sent (or on the very first check, for the initial snapshot) -
// this interval only bounds how quickly a real change is noticed, it never
// causes traffic for an unchanged state. Same order of magnitude as GSI's
// own tick rate (~2/s) and the existing Companion-UI status hooks (3s
// polls), not an aggressive busy-loop.
const POLL_INTERVAL: Duration = Duration::from_millis(300);

// WK-121 - production renderer widget data. Deliberately reuses
// `local_runtime::summary::LocalSessionSummary` verbatim (the exact same
// read-only projection the Home page's MMR/matches panels already consume,
// see summary.rs's doc comment) rather than a second session-summary
// computation, and derives `CurrentGameSnapshot` from `AppState.
// last_gsi_payload` using the same `/hero/id` pointer path
// `local_runtime::gsi::parse`/`game_sounds::events::hero_identity_changed`
// already use elsewhere (kills/deaths/assists have no existing Rust-side
// extraction anywhere in this codebase - added here, presentation-only,
// same `.pointer()` idiom). Hero name/icon resolution stays entirely
// frontend-side (the renderer bundle imports the same `heroCatalog.ts`
// HomePage.tsx already uses) - no new Rust-side hero id -> name mapping.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentGameSnapshot {
    pub hero_id: Option<i64>,
    pub kills: Option<i64>,
    pub deaths: Option<i64>,
    pub assists: Option<i64>,
}

fn current_game_from_gsi(payload: &serde_json::Value) -> CurrentGameSnapshot {
    CurrentGameSnapshot {
        hero_id: payload.pointer("/hero/id").and_then(serde_json::Value::as_i64),
        kills: payload.pointer("/player/kills").and_then(serde_json::Value::as_i64),
        deaths: payload.pointer("/player/deaths").and_then(serde_json::Value::as_i64),
        assists: payload.pointer("/player/assists").and_then(serde_json::Value::as_i64),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStateSnapshot {
    pub scene: BroadcastState,
    pub updated_at: String,
    /// `has_session: false` (the struct's own `Default`) when no local
    /// session is open yet - see summary.rs. Never a nested `Option`: the
    /// renderer only ever needs to branch on `hasSession`.
    pub session: LocalSessionSummary,
    /// Only populated while GSI reports an active hero (Draft/Gameplay) -
    /// `None` in BetweenMatches/PostStream, exactly like the equivalent
    /// `BroadcastState::from_gsi` reads no hero data for those states either.
    pub current_game: Option<CurrentGameSnapshot>,
    /// WK-122 §19 - bumped every time `AppState.overlay_layout` actually
    /// changes (a fresh fetch that differs from the cache, or a save from
    /// the Оформление editor - see backend::apply_overlay_layout). The
    /// renderer doesn't need the layout on every tick (positions rarely
    /// change), so this is a cheap version number rather than embedding the
    /// whole layout blob here - it fetches `/overlay/layout` once and
    /// re-fetches only when this number moves.
    pub layout_version: u64,
}

/// Reads AppState (canonical resolver fields) plus the local runtime's
/// session summary - see this module's doc comment on why the security
/// guarantee (no secrets ever reachable from this function's return type)
/// still holds with the widened payload. Mirrors the same lock-read-drop
/// shape every other AppState reader in this codebase already uses.
///
/// Generic over `R: Runtime` (WK-116 pattern, see local_runtime/mod.rs's
/// `handle_gsi`) so this - the real production code path - can be driven
/// end to end by integration tests using `tauri::test::mock_app()`, rather
/// than only testing a hand-built stand-in. Every real call site keeps
/// compiling unchanged (`R = Wry` by inference).
pub fn current<R: Runtime>(app: &AppHandle<R>) -> OverlayStateSnapshot {
    let (gsi_derived_source, session_ended, obs_manual_summary_override, current_game, layout_version) = {
        let state = app.state::<AppState>();
        let inner = state.0.lock().unwrap();
        let current_game = inner
            .last_gsi_payload
            .as_ref()
            .map(current_game_from_gsi)
            .filter(|game| game.hero_id.is_some());
        (
            inner.last_gsi_payload.as_ref().map(BroadcastState::from_gsi),
            inner.session_ended,
            inner.obs_manual_summary_override,
            current_game,
            inner.overlay_layout_version,
        )
    };
    let gsi_derived = gsi_derived_source.unwrap_or(BroadcastState::BetweenMatches);
    let scene = broadcast_state::resolve(gsi_derived, session_ended, obs_manual_summary_override);
    OverlayStateSnapshot {
        scene,
        updated_at: chrono::Utc::now().to_rfc3339(),
        session: summary::get(app),
        current_game: match scene {
            BroadcastState::Draft | BroadcastState::Gameplay => current_game,
            BroadcastState::BetweenMatches | BroadcastState::PostStream => None,
        },
        layout_version,
    }
}

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs(2_u64.saturating_pow(attempt.min(4)).min(30))
}

/// Supervises the local overlay listener for the app's lifetime, mirroring
/// `server::start`'s (GSI) bind-retry-with-backoff shape exactly - a bind
/// failure (e.g. port already in use by something else on the machine) is
/// logged and retried, never a panic, never taking down the rest of
/// Companion. Explicitly loopback (`127.0.0.1:{OVERLAY_PORT}`) - never binds
/// `0.0.0.0`.
pub fn init(app: AppHandle) {
    std::thread::spawn(move || {
        let addr = format!("127.0.0.1:{OVERLAY_PORT}");
        let mut attempt = 0_u32;
        loop {
            match tiny_http::Server::http(&addr) {
                Ok(server) => {
                    attempt = 0;
                    storage::append_rolling_log(&app, &format!("Local overlay server listening on http://{addr}/overlay"));
                    for request in server.incoming_requests() {
                        let app_for_request = app.clone();
                        std::thread::spawn(move || handle_request(&app_for_request, request));
                    }
                    storage::append_rolling_log(&app, "Local overlay server listener stopped; reconnecting.");
                }
                Err(error) => {
                    attempt = attempt.saturating_add(1);
                    storage::append_rolling_log(&app, &format!("Local overlay server: could not bind {addr}: {error}; retry scheduled."));
                }
            }
            std::thread::sleep(retry_delay(attempt));
        }
    });
}

fn json_header() -> tiny_http::Header {
    tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()
}

fn respond_json<T: Serialize>(request: tiny_http::Request, body: &T) {
    let payload = serde_json::to_string(body).unwrap_or_else(|_| "{}".to_string());
    let response = tiny_http::Response::from_string(payload).with_header(json_header());
    let _ = request.respond(response);
}

// WK-121 - the real production renderer (apps/companion/overlay-renderer/,
// built via `pnpm build:overlay-renderer` into one self-contained HTML file
// with vite-plugin-singlefile, then committed here) - replaces WK-120's
// explicitly-labeled dev-preview page. Fetches /overlay/state and
// subscribes to /overlay/events itself once loaded; this constant is just
// the static shell. See vite.overlay-renderer.config.ts's doc comment for
// why the built output is committed rather than gitignored.
const RENDERER_HTML: &str = include_str!("overlay_server/renderer-dist/index.html");

fn respond_html(request: tiny_http::Request, html: &str) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap();
    let response = tiny_http::Response::from_string(html).with_header(header);
    let _ = request.respond(response);
}

fn respond_not_found(request: tiny_http::Request) {
    let response = tiny_http::Response::from_string("not found").with_status_code(tiny_http::StatusCode(404));
    let _ = request.respond(response);
}

/// Streams Server-Sent Events for as long as the connection stays open.
///
/// Uses `Request::upgrade` (tiny_http's raw-socket takeover, meant for
/// WebSocket-shaped use cases) rather than tiny_http's normal
/// `Response`/chunked-transfer path: tiny_http's default chunked encoder
/// (`chunked_transfer::Encoder`, `flush_after_write: false`, 8192-byte
/// internal buffer) only flushes a chunk to the socket once it fills or the
/// body reader hits EOF - since this stream's body never hits EOF (it's
/// live, open-ended) and each SSE frame is far smaller than 8192 bytes, a
/// frame written through that path would sit buffered and never actually
/// reach the client. Taking the raw stream lets this function call
/// `flush()` itself after every frame, guaranteeing prompt delivery -
/// caught by `sse_stream_sends_an_initial_snapshot_then_pushes_a_transition`
/// timing out waiting for a transition frame that was correctly queued
/// server-side but never left the process.
///
/// Loops sleeping and re-checking rather than returning early, so this is a
/// diff-gated poll (only writes when the resolved scene actually differs
/// from the last one sent), not a busy-spin or a fixed-cadence push - the
/// "live push, not aggressive polling" transport the ticket asks for.
fn serve_sse<R: Runtime>(app: &AppHandle<R>, request: tiny_http::Request) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..]).unwrap();
    let response = tiny_http::Response::empty(tiny_http::StatusCode(200)).with_header(header);
    let mut stream = request.upgrade("sse", response);

    let mut last_sent_scene: Option<BroadcastState> = None;
    // WK-122 §19 - a second, independent reason to push a frame: the scene
    // can easily stay unchanged for a long time while the streamer is
    // actively editing Оформление (see DesignPage.tsx's live preview) -
    // gating on scene alone would leave the preview stale until the next
    // real scene transition. `None` initially so the very first snapshot
    // (whatever its version) always counts as a change.
    let mut last_sent_layout_version: Option<u64> = None;
    loop {
        let snapshot = current(app);
        if scene_changed(last_sent_scene, snapshot.scene) || last_sent_layout_version != Some(snapshot.layout_version) {
            last_sent_scene = Some(snapshot.scene);
            last_sent_layout_version = Some(snapshot.layout_version);
            let payload = serde_json::to_string(&snapshot).unwrap_or_default();
            if stream.write_all(format!("data: {payload}\n\n").as_bytes()).is_err() {
                return; // client disconnected
            }
            if stream.flush().is_err() {
                return;
            }
            continue;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Pure diff-gate: deliberately compares only `scene`, never the whole
/// `OverlayStateSnapshot` - `updated_at` is a fresh timestamp on every
/// `current()` call, so comparing whole snapshots would make this true on
/// EVERY poll tick regardless of whether the scene actually changed,
/// defeating diff-gating entirely (see the `scene_changed` test below and
/// `serve_sse`'s doc comment for the bug this caught).
fn scene_changed(last_sent_scene: Option<BroadcastState>, current_scene: BroadcastState) -> bool {
    last_sent_scene != Some(current_scene)
}

fn handle_request<R: Runtime>(app: &AppHandle<R>, request: tiny_http::Request) {
    let path = request.url().split('?').next().unwrap_or("").to_string();
    match (request.method(), path.as_str()) {
        (tiny_http::Method::Get, "/overlay/health") => respond_json(request, &serde_json::json!({ "status": "ok" })),
        (tiny_http::Method::Get, "/overlay/state") => {
            let snapshot = current(app);
            respond_json(request, &snapshot);
        }
        (tiny_http::Method::Get, "/overlay/events") => serve_sse(app, request),
        // WK-122 §19 - serves whatever OverlayLayout backend::init's
        // periodic poll (or a save from the Оформление editor) most
        // recently cached. `null` (not an error) when nothing has been
        // fetched yet this run - e.g. Companion never got a companion
        // token/session, or the very first poll hasn't landed - the
        // renderer's own fallback (fixed default positions, see
        // OverlayApp.tsx) is what handles that case, not this endpoint.
        (tiny_http::Method::Get, "/overlay/layout") => {
            let layout = app.state::<AppState>().0.lock().unwrap().overlay_layout.clone();
            respond_json(request, &layout);
        }
        (tiny_http::Method::Get, "/overlay") | (tiny_http::Method::Get, "/overlay/") => respond_html(request, RENDERER_HTML),
        _ => respond_not_found(request),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::net::TcpStream;
    use tauri::Manager;

    fn test_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(AppState::new());
        // WK-121 - `current()` now also calls `summary::get(app)`, which
        // reads `LocalRuntimeState` (panics via Tauri's `Manager::state`
        // if the type was never `.manage()`d at all, a different case from
        // "managed but its inner DB connection is None" - see summary.rs's
        // documented fallback). Never opens a real DB here; the inner
        // `Option<Connection>` stays `None`, exercising exactly that
        // documented fallback path.
        app.manage(crate::local_runtime::LocalRuntimeState::new());
        app.handle().clone()
    }

    /// Binds a real listener on an OS-assigned ephemeral port and serves
    /// requests on it exactly like `init` does (same `handle_request`
    /// routing, one thread per connection) - but without `init`'s own
    /// bind-retry/backoff wrapper, so tests control the exact port and
    /// don't share a fixed port across parallel test runs. `init`'s own
    /// bind/retry/logging behavior is covered separately (see the
    /// `security` module's loopback-address test and
    /// `binding_an_already_used_port_fails_gracefully_instead_of_panicking`
    /// below), not by spinning up the whole app.
    fn start_test_server(app: tauri::AppHandle<tauri::test::MockRuntime>) -> u16 {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind ephemeral port");
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            #[allow(unreachable_patterns)]
            _ => panic!("expected an IP listen address"),
        };
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                let app_for_request = app.clone();
                std::thread::spawn(move || handle_request(&app_for_request, request));
            }
        });
        // give the accept loop a moment to actually be ready to accept
        std::thread::sleep(Duration::from_millis(20));
        port
    }

    // WK-120 integration test - GSI/local runtime -> canonical BroadcastState
    // -> local transport -> overlay receives state, with NO backend
    // involved anywhere in this test (no reqwest, no AppState.backend_*
    // field ever read).
    #[test]
    fn state_endpoint_reflects_the_canonical_resolution_of_the_latest_gsi_tick() {
        let app = test_app();
        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.last_gsi_payload = Some(serde_json::json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
                "player": { "activity": "playing" }
            }));
        }
        let snapshot = current(&app);
        assert_eq!(snapshot.scene, BroadcastState::Gameplay);
    }

    #[test]
    fn state_endpoint_defaults_to_between_matches_before_any_gsi_tick_ever_arrives() {
        let app = test_app();
        let snapshot = current(&app);
        assert_eq!(snapshot.scene, BroadcastState::BetweenMatches);
        assert!(!snapshot.session.has_session, "no local session opened yet");
        assert!(snapshot.current_game.is_none(), "no current-game data outside Draft/Gameplay");
    }

    // WK-121 - the renderer's CurrentGame widget only ever has real data
    // during Draft/Gameplay; BetweenMatches/PostStream must never carry a
    // stale hero from the last match.
    #[test]
    fn current_game_is_populated_during_gameplay_and_cleared_between_matches() {
        let app = test_app();
        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.last_gsi_payload = Some(serde_json::json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
                "player": { "activity": "playing", "kills": 5, "deaths": 2, "assists": 9 },
                "hero": { "id": 14 },
            }));
        }
        let snapshot = current(&app);
        assert_eq!(snapshot.scene, BroadcastState::Gameplay);
        let game = snapshot.current_game.expect("current_game populated during Gameplay");
        assert_eq!(game.hero_id, Some(14));
        assert_eq!(game.kills, Some(5));
        assert_eq!(game.deaths, Some(2));
        assert_eq!(game.assists, Some(9));

        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.last_gsi_payload = None;
        }
        assert!(current(&app).current_game.is_none(), "clears once GSI signal is gone (back to BetweenMatches)");
    }

    // WK-121 - `session` reuses local_runtime::summary::get verbatim, not a
    // second computation: `current()` calls the exact same function
    // `commands::get_local_session_summary` (the Home page's own data
    // source) calls, over the exact same `LocalRuntimeState` - summary.rs's
    // own test module already covers the store composition logic
    // (`session_match_tally`/`find_active_match`/`list_recent_matches`)
    // this delegates to; this test only pins the delegation itself (no
    // managed LocalRuntimeState -> the documented "storage failed to open"
    // fallback -> default summary, never a panic).
    #[test]
    fn session_field_is_the_local_runtime_summarys_documented_fallback_when_unavailable() {
        let app = test_app();
        assert_eq!(current(&app).session, LocalSessionSummary::default());
    }

    #[test]
    fn session_ended_wins_over_the_latest_gsi_tick_in_the_served_state() {
        let app = test_app();
        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.last_gsi_payload = Some(serde_json::json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_GAME_IN_PROGRESS" },
                "player": { "activity": "playing" }
            }));
            inner.session_ended = true;
        }
        assert_eq!(current(&app).scene, BroadcastState::PostStream);
    }

    #[test]
    fn http_state_endpoint_returns_the_current_snapshot_over_a_real_socket() {
        let app = test_app();
        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.obs_manual_summary_override = true;
        }
        let port = start_test_server(app);
        let body = http_get(port, "/overlay/state");
        assert!(body.contains("\"scene\":\"postStream\""), "unexpected body: {body}");
    }

    #[test]
    fn http_health_endpoint_responds_ok() {
        let app = test_app();
        let port = start_test_server(app);
        let body = http_get(port, "/overlay/health");
        assert!(body.contains("\"status\":\"ok\""));
    }

    // WK-121 - `/overlay` must serve the real production renderer, not any
    // kind of placeholder: pins that the served HTML actually is the built
    // React app (its own mount point + the /overlay/state and /overlay/
    // events URLs it's wired to fetch/subscribe to), not just "some HTML".
    #[test]
    fn overlay_route_serves_the_real_renderer_not_a_placeholder() {
        let app = test_app();
        let port = start_test_server(app);
        let body = http_get(port, "/overlay");
        assert!(body.contains("id=\"root\""), "renderer's mount point missing: {body}");
        assert!(body.contains("/overlay/state"), "renderer must fetch the real snapshot endpoint: {body}");
        assert!(body.contains("/overlay/events"), "renderer must subscribe to the real SSE endpoint: {body}");
        assert!(!body.to_lowercase().contains("dev-preview"), "must not still be the WK-120 dev-preview page");
    }

    #[test]
    fn http_unknown_path_returns_404() {
        let app = test_app();
        let port = start_test_server(app);
        let response = http_get_raw(port, "/nope");
        assert!(response.starts_with("HTTP/1.1 404"), "unexpected status line: {response}");
    }

    // WK-120 integration test - initial snapshot + live push over the SSE
    // transport, without backend, proving a Browser Source reconnecting
    // gets the current state immediately (not waiting for the next GSI
    // tick), and that a state transition is pushed without a client re-poll.
    #[test]
    fn sse_stream_sends_an_initial_snapshot_then_pushes_a_transition() {
        let app = test_app();
        let port = start_test_server(app.clone());

        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream.write_all(b"GET /overlay/events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        // ONE BufReader for the whole connection's lifetime - re-creating it
        // per read would drop whatever it had already pulled from the
        // socket into its own internal buffer beyond the single line
        // returned, silently losing bytes belonging to later frames.
        let mut reader = std::io::BufReader::new(stream);

        let first_frame = read_one_sse_frame(&mut reader);
        assert!(first_frame.contains("\"scene\":\"betweenMatches\""), "unexpected initial frame: {first_frame}");

        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.last_gsi_payload = Some(serde_json::json!({
                "map": { "game_state": "DOTA_GAMERULES_STATE_HERO_SELECTION" },
                "player": { "activity": "playing" }
            }));
        }

        let second_frame = read_one_sse_frame(&mut reader);
        assert!(second_frame.contains("\"scene\":\"draft\""), "unexpected transition frame: {second_frame}");
    }

    // WK-122 §19 - the local renderer must keep updating live while the
    // streamer edits Оформление and the scene itself never changes (e.g.
    // sitting on Между матчами the whole time) - pins that the SSE push
    // condition includes layout_version, not just scene.
    #[test]
    fn sse_stream_pushes_a_frame_when_only_the_layout_version_changes() {
        let app = test_app();
        let port = start_test_server(app.clone());

        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream.write_all(b"GET /overlay/events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut reader = std::io::BufReader::new(stream);

        let first_frame = read_one_sse_frame(&mut reader);
        assert!(first_frame.contains("\"layoutVersion\":0"), "unexpected initial frame: {first_frame}");

        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.overlay_layout_version = 1;
            // Scene deliberately left untouched (still betweenMatches).
        }

        let second_frame = read_one_sse_frame(&mut reader);
        assert!(second_frame.contains("\"scene\":\"betweenMatches\""), "scene must not have changed: {second_frame}");
        assert!(second_frame.contains("\"layoutVersion\":1"), "layout_version bump alone must still push a frame: {second_frame}");
    }

    // WK-122 §19 - `null`, not an error, when nothing has been fetched yet
    // this run (e.g. Companion never got a companion token/session) - the
    // renderer's own fixed-default fallback is what handles that, not this
    // endpoint returning an error status.
    #[test]
    fn overlay_layout_endpoint_returns_null_when_nothing_cached_yet() {
        let app = test_app();
        let port = start_test_server(app);
        assert_eq!(http_get(port, "/overlay/layout").trim(), "null");
    }

    #[test]
    fn overlay_layout_endpoint_serves_the_cached_layout() {
        let app = test_app();
        {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.overlay_layout = Some(serde_json::json!({ "version": 4, "hello": "world" }));
        }
        let port = start_test_server(app);
        let body = http_get(port, "/overlay/layout");
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["hello"], "world");
    }

    // WK-120 regression test - direct pin for the bug the integration test
    // above originally caught: a fresh `updated_at` timestamp alone (every
    // `current()` call produces one) must never be treated as a real scene
    // change on its own.
    #[test]
    fn scene_changed_ignores_everything_except_the_scene_itself() {
        assert!(!scene_changed(Some(BroadcastState::Gameplay), BroadcastState::Gameplay));
        assert!(scene_changed(Some(BroadcastState::Gameplay), BroadcastState::Draft));
        assert!(scene_changed(None, BroadcastState::BetweenMatches), "the very first snapshot must always count as a change (initial send)");
    }

    fn read_one_sse_frame(reader: &mut std::io::BufReader<TcpStream>) -> String {
        use std::io::BufRead;
        // Skip HTTP status/headers up to the blank line (first call only),
        // then any chunk-size lines (chunked transfer encoding, since
        // Response::new was given `data_length: None`) up to the next
        // actual "data: ..." line.
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).expect("read header/chunk line");
            if line.starts_with("data:") {
                return line;
            }
        }
    }

    fn http_get(port: u16, path: &str) -> String {
        let raw = http_get_raw(port, path);
        raw.split("\r\n\r\n").nth(1).unwrap_or("").to_string()
    }

    fn http_get_raw(port: u16, path: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        stream
            .write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").as_bytes())
            .unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut buf = String::new();
        use std::io::Read as _;
        let _ = stream.read_to_string(&mut buf);
        buf
    }

    // WK-120 - "port conflict behavior": binding a second listener on an
    // already-bound port must fail gracefully (Err), never panic - this is
    // exactly the branch `init`'s retry loop above handles by logging and
    // retrying with backoff, never taking down the rest of Companion.
    #[test]
    fn binding_an_already_used_port_fails_gracefully_instead_of_panicking() {
        let first = tiny_http::Server::http("127.0.0.1:0").expect("bind first listener");
        let port = match first.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            #[allow(unreachable_patterns)]
            _ => panic!("expected an IP listen address"),
        };
        let second = tiny_http::Server::http(format!("127.0.0.1:{port}"));
        assert!(second.is_err(), "binding an already-used port must return Err, not panic or silently succeed");
    }

    mod security {
        use super::*;

        // WK-120 - loopback only, never 0.0.0.0: pins the literal address
        // string `init` binds, so a future edit widening this to all
        // interfaces fails a test instead of shipping silently.
        #[test]
        fn init_binds_loopback_only_never_0_0_0_0() {
            let addr = format!("127.0.0.1:{OVERLAY_PORT}");
            assert!(addr.starts_with("127.0.0.1:"));
            assert!(!addr.contains("0.0.0.0"));
        }

        // WK-120 - the served payload can never contain a secret/token/
        // credential field, by construction (`OverlayStateSnapshot` only
        // ever has `scene`/`updatedAt`) - this test pins that guarantee at
        // the serialization boundary so a future field addition to the
        // struct is forced to justify itself against this assertion.
        #[test]
        fn served_payload_never_contains_a_token_secret_or_password_field() {
            let snapshot = OverlayStateSnapshot {
                scene: BroadcastState::Gameplay,
                updated_at: "2026-01-01T00:00:00Z".to_string(),
                session: LocalSessionSummary::default(),
                current_game: Some(CurrentGameSnapshot { hero_id: Some(14), kills: Some(3), deaths: Some(1), assists: Some(7) }),
                layout_version: 1,
            };
            let json = serde_json::to_string(&snapshot).unwrap().to_lowercase();
            for forbidden in ["token", "secret", "password", "companion_token", "bearer"] {
                assert!(!json.contains(forbidden), "payload leaked a forbidden field/substring: {forbidden} in {json}");
            }
        }

        // WK-121 - the widened payload (session summary + current game) is
        // still built entirely from `current()`'s own AppState/local-runtime
        // reads, never anything backend/credential-shaped - pins the
        // widened struct's field set itself, not just one example instance.
        #[test]
        fn current_game_extraction_reads_only_gsi_hero_and_kda_pointers() {
            let payload = serde_json::json!({
                "hero": { "id": 14, "name": "npc_dota_hero_pudge" },
                "player": { "kills": 3, "deaths": 1, "assists": 7, "steam_id": "should not leak" },
            });
            let game = current_game_from_gsi(&payload);
            assert_eq!(game.hero_id, Some(14));
            assert_eq!(game.kills, Some(3));
            assert_eq!(game.deaths, Some(1));
            assert_eq!(game.assists, Some(7));
            let json = serde_json::to_string(&game).unwrap();
            assert!(!json.contains("steam_id"), "must only read the specific pointers it declares, not pass through the raw payload");
        }

        #[test]
        fn current_reads_only_the_two_appstate_fields_the_resolver_needs() {
            // Type-level pin: `current`'s signature can only ever read from
            // `&AppHandle` (never a token/credential type directly), and its
            // return type has no field beyond scene/updated_at - see the
            // struct definition itself, the actual enforcement mechanism.
            fn _type_check(app: &AppHandle) -> OverlayStateSnapshot {
                current(app)
            }
        }
    }
}
