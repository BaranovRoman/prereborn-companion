mod backend;
mod chat_overlay;
mod clips;
mod commands;
mod core;
mod diagnostics;
mod hotkeys;
mod obs;
mod secure_storage;
mod silero;
mod state;
mod storage;
mod tts_common;
use tauri::{menu::{Menu,MenuItem},tray::TrayIconBuilder,Manager,WindowEvent};
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
                clips::stop(app);
                // Off the UI thread: a clean worker stop waits for the WebView's
                // audio-fence ACK, which cannot arrive while this event loop is
                // blocked. Without it the process journal stays Draining.
                let app=app.clone();
                std::thread::spawn(move||{
                    if let Some(manager)=app.try_state::<core::plugin_manager::PluginManager>(){manager.shutdown();}
                    app.exit(0);
                });
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

fn launched_hidden<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().any(|arg| arg == "--hidden")
}

/// Reliability pass - focuses the existing window on a second launch (see
/// `run()`'s single-instance plugin registration below). A real webview
/// window can't be constructed outside a running app, so this has no unit
/// test - it's covered by the packaged Windows double-launch smoke check
/// instead (see the report).
fn focus_existing_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}
#[cfg_attr(mobile,tauri::mobile_entry_point)]
pub fn run(){
 tauri::Builder::default().invoke_system(core::plugin_ipc::initialization_script())
 .plugin(tauri_plugin_single_instance::init(|app,_args,_cwd|focus_existing_window(app)))
 .register_uri_scheme_protocol("plugin-ui",|context,request|core::plugin_ui::response(context.app_handle(),request.uri().path()))
 .plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_dialog::init())
 .plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_process::init())
 .plugin(tauri_plugin_global_shortcut::Builder::new().build())
 .plugin(tauri_plugin_notification::init())
 .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent,Some(vec!["--hidden"])))
 .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(tauri_plugin_window_state::StateFlags::SIZE|tauri_plugin_window_state::StateFlags::POSITION|tauri_plugin_window_state::StateFlags::MAXIMIZED).build())
 .manage(AppState::new()).manage(diagnostics::DiagnosticsState::new()).manage(silero::SileroState::new()).manage(hotkeys::HotkeysState::new()).manage(clips::ClipsState::new()).manage(chat_overlay::ChatOverlayState::default())
 .setup(|app|{
  let handle=app.handle().clone();storage::init(&handle)?;
  handle.state::<AppState>().0.lock().unwrap().core.log_dir=Some(storage::logs_root(&handle).to_string_lossy().into());
  // No game DB, backup, GSI listener or installed live process is opened here.
  // Root containment must precede the very first WebView, including its audio.
  let native=(||->Result<std::sync::Arc<core::plugin_audio::HostAudio>,String>{
   let root=handle.path().app_data_dir().map_err(|_|"plugin_data_path_unavailable")?.join("plugins/infrastructure");std::fs::create_dir_all(&root).map_err(|_|"plugin_data_path_unavailable")?;
   let audio=std::sync::Arc::new(core::plugin_audio::HostAudio::open(&root.join("transport.sqlite3"))?);handle.manage(audio.clone());
   #[cfg(windows)]audio.initialize_host_before_webview()?;
   Ok(audio)
  })();
  core::plugin_manager::setup(&handle);let manager=handle.state::<core::plugin_manager::PluginManager>();
  match native{Ok(audio)=>{if let Err(error)=manager.attach_worker_host(handle.clone(),audio){manager.transport_unavailable(error);}else{manager.consume_workers();let manager=manager.inner().clone();std::thread::spawn(move||manager.recover_interrupted());}},Err(error)=>{storage::append_rolling_log(&handle,&format!("Plugin transport unavailable: {error}"));manager.transport_unavailable(error);}}
  let config=handle.config().app.windows.first().ok_or("main_window_configuration_missing")?;
  tauri::WebviewWindowBuilder::from_config(app,config)?.visible(!launched_hidden(std::env::args())).build()?;
  silero::init(&handle);hotkeys::init(&handle);clips::init(&handle);backend::init(handle.clone());obs::init(handle.clone());diagnostics::recover_last_session(&handle);
  storage::append_rolling_log(&handle,"PreReborn Companion core starting up.");build_tray(&handle)?;Ok(())
 })
 .on_window_event(|window,event|{if let WindowEvent::CloseRequested{api,..}=event{let _=window.hide();api.prevent_close();}})
 .invoke_handler(tauri::generate_handler![
 commands::get_status,
 commands::check_companion_update,
 commands::open_logs_folder,
 commands::open_stream_settings,
 commands::get_steam_integration_status,
 commands::disconnect_steam,
 commands::get_twitch_integration_status,
 commands::get_donation_alerts_integration_status,
 commands::connect_twitch,
 commands::disconnect_twitch,
 commands::connect_donation_alerts,
 commands::disconnect_donation_alerts,
 commands::save_companion_token,
 commands::get_account_status,
 commands::account_login,
 commands::account_logout,
 commands::get_twitch_chat,
 chat_overlay::chat_overlay_open,
 chat_overlay::chat_overlay_close,
 chat_overlay::chat_overlay_set_click_through,
 chat_overlay::chat_overlay_status,
 commands::diagnostics_get_status,
 commands::diagnostics_start,
 commands::diagnostics_stop,
 commands::diagnostics_clear,
 commands::get_silero_status,
 commands::set_silero_enabled,
 commands::set_silero_voice,
 commands::synthesize_silero_tts,
 commands::diagnostics_trace_tts_frontend,
 commands::get_skip_hotkey_status,
 commands::set_skip_hotkey,
 commands::get_clips_status,
 commands::get_clips_access,
 commands::set_clips_hotkey,
 commands::set_clip_duration,
 commands::create_clip_now,
 commands::open_clip,
 commands::clear_clips_history,
 commands::diagnostics_export,
 commands::clear_log,
 commands::save_obs_config,
 commands::test_obs_connection,
 core::plugin_manager::plugins_view,
 core::plugin_manager::plugins_refresh,
 core::plugin_manager::plugins_install,
 core::plugin_manager::plugins_cancel,
 core::plugin_manager::plugins_action,
 core::plugin_manager::plugins_command,
 core::plugin_audio::plugin_audio_ack,
 core::plugin_audio::plugin_audio_fence_ack
 ])
 .build(tauri::generate_context!()).expect("error while building tauri application")
 .run(|app,event|{
  #[cfg(windows)]if let tauri::RunEvent::ExitRequested{api,..}=&event{if commands::updater_exit_in_progress(){api.prevent_exit();}}
  if matches!(event,tauri::RunEvent::Exit){clips::stop(app);if let Some(manager)=app.try_state::<core::plugin_manager::PluginManager>(){manager.shutdown();}}
 });
}
#[cfg(test)]
mod tests {
    use super::launched_hidden;

    #[test]
    fn a_normal_launch_with_no_args_is_not_hidden() {
        assert!(!launched_hidden(Vec::<String>::new()));
    }

    #[test]
    fn the_autostart_hidden_flag_is_detected() {
        assert!(launched_hidden(vec!["--hidden".to_string()]));
    }

    #[test]
    fn the_exe_path_alone_first_argv_entry_is_not_mistaken_for_hidden() {
        // argv[0] is always the executable path on every platform this app
        // ships for - must never itself be read as "--hidden".
        assert!(!launched_hidden(vec![
            r"C:\Program Files\PreReborn Companion\dota-companion.exe".to_string()
        ]));
    }

    #[test]
    fn hidden_is_detected_regardless_of_other_args_or_position() {
        assert!(launched_hidden(vec![
            r"C:\Program Files\PreReborn Companion\dota-companion.exe".to_string(),
            "--some-other-flag".to_string(),
            "--hidden".to_string(),
        ]));
    }
}
