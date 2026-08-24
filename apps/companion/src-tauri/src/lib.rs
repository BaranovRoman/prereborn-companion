mod backend;
mod commands;
mod diagnostics;
mod gsi;
mod hotkeys;
mod obs;
mod server;
mod silero;
mod state;
mod storage;
mod tts_common;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

use state::AppState;

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("PreReborn Companion")
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                silero::stop(app);
                hotkeys::stop(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Runs once at startup: tries to find Dota and write the GSI config with no
/// user interaction, so the happy path is zero clicks. Failures here are not
/// fatal — the UI's "Find Dota" / "Install GSI" buttons cover the fallback.
fn try_auto_provision(app: &tauri::AppHandle) {
    let Some(dota_path) = gsi::finder::find_dota_auto() else {
        storage::append_rolling_log(
            app,
            "Startup auto-detection found no Dota install; waiting for manual folder pick.",
        );
        return;
    };
    storage::append_rolling_log(app, &format!("Dota auto-detected at {dota_path}"));

    {
        let state = app.state::<AppState>();
        let mut inner = state.0.lock().unwrap();
        inner.dota_path = Some(dota_path.clone());
        inner.dota_source = Some("auto".to_string());
    }

    match gsi::config::install_gsi(&dota_path) {
        Ok(target) => {
            let state = app.state::<AppState>();
            let mut inner = state.0.lock().unwrap();
            inner.gsi_installed = true;
            inner.gsi_config_path = Some(target.to_string_lossy().to_string());
            drop(inner);
            storage::append_rolling_log(
                app,
                &format!("GSI config auto-installed at {}", target.display()),
            );
        }
        Err(e) => {
            storage::append_rolling_log(
                app,
                &format!("GSI auto-install failed, use the Install GSI button: {e}"),
            );
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Companion UI 2.0 - "Запускать вместе с Windows" toggle
        // (Settings). `--hidden` is appended to the launch command the OS
        // registers (Windows Run key) - checked below in `setup()` to hide
        // the main window immediately on an autostart launch, matching
        // AutostartSetting's hint text ("откроется свёрнутым в трей"). A
        // normal user-initiated launch (double-clicking the app, no
        // `--hidden` arg) is unaffected - the window still opens visible.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(AppState::new())
        .manage(diagnostics::DiagnosticsState::new())
        .manage(silero::SileroState::new())
        .manage(hotkeys::HotkeysState::new())
        .setup(|app| {
            let handle = app.handle().clone();

            // Autostart launch (see the `tauri_plugin_autostart::init` call
            // above) - the window already exists at this point (Tauri
            // creates windows declared in tauri.conf.json before running
            // `setup()`), so hide it immediately rather than letting it
            // flash visible before the tray takes over.
            if std::env::args().any(|arg| arg == "--hidden") {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            storage::init(&handle)?;
            // One-shot safety net for installs that accumulated a legacy
            // logs/payloads directory before write_payload_file() was
            // removed from the normal GSI request path - never a periodic
            // scan, just this one check at launch (cleanup_legacy_payloads
            // itself is a no-op once nothing is left to clean).
            storage::cleanup_legacy_payloads(&handle);
            silero::init(&handle);
            hotkeys::init(&handle);
            {
                let state = handle.state::<AppState>();
                let mut inner = state.0.lock().unwrap();
                inner.log_dir = Some(storage::logs_root(&handle).to_string_lossy().to_string());
            }
            storage::append_rolling_log(&handle, "PreReborn Companion starting up.");
            diagnostics::recover_last_session(&handle);

            server::start(handle.clone());

            try_auto_provision(&handle);
            backend::init(handle.clone());
            obs::init(handle.clone());

            build_tray(&handle)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Keep the app alive in the tray instead of quitting when the
            // window is closed — the GSI server must keep running.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::find_dota,
            commands::pick_dota_folder,
            commands::install_gsi,
            commands::open_logs_folder,
            commands::open_dota_folder,
            commands::clear_log,
            commands::save_companion_token,
            commands::get_twitch_chat,
            commands::open_twitch_settings,
            commands::resend_current_state,
            commands::save_obs_config,
            commands::test_obs_connection,
            commands::switch_obs_scene,
            commands::diagnostics_get_status,
            commands::diagnostics_start,
            commands::diagnostics_stop,
            commands::diagnostics_clear,
            commands::diagnostics_export,
            commands::get_silero_status,
            commands::set_silero_enabled,
            commands::set_silero_voice,
            commands::synthesize_silero_tts,
            commands::diagnostics_trace_tts_frontend,
            commands::get_skip_hotkey_status,
            commands::set_skip_hotkey,
            commands::get_stream_session,
            commands::reset_stream_session,
            commands::end_stream_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
