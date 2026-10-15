use super::*;
use companion_dota_domain::{events::{detect_events_with_state, PendingConfirmations},projection::project};
use serde_json::json;

// Real projection/detector/binding/managed-file path; no fabricated match session,
// OBS, backend or successful playback ACK. WebView playback is checked separately.
#[test]
fn techies_demo_and_solo_bot_frames_resolve_existing_managed_audio_without_session_or_obs() {
    let root = tempfile::tempdir().unwrap();
    let sounds = root.path().join("sounds");
    std::fs::create_dir(&sounds).unwrap();
    let audio = b"RIFF\x24\x00\x00\x00WAVEfmt ";
    std::fs::write(sounds.join("existing.wav"), audio).unwrap();
    std::fs::write(root.path().join("game-sounds-config.json"), serde_json::to_vec(&json!({
        "schemaVersion":1,"enabled":true,"masterVolume":63,
        "bindings":[{"eventId":"techies_suicide","kind":"abilityCast","assetId":"existing"}],
        "assets":[{"id":"existing","fileName":"existing.wav","originalName":"jump.wav","sizeBytes":audio.len()}]
    })).unwrap()).unwrap();
    let settings = config::load_from(&root.path().join("game-sounds-config.json"));
    assert!(settings.enabled);
    assert_eq!(settings.master_volume, 63);
    for (state, custom) in [("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "hero_demo"),
                             ("DOTA_GAMERULES_STATE_GAME_IN_PROGRESS", "")] {
        let mut before = json!({
            "auth":{"token":"must-not-cross"},"provider":{"steamid":"must-not-cross"},
            "player":{"activity":"playing","team_name":"radiant","steamid":"must-not-cross"},
            "map":{"game_state":state,"matchid":"0","customgamename":custom},
            "hero":{"id":105},
            "abilities":{"ability0":{"name":"techies_suicide","cooldown":0,"level":4}},
            "items":{"slot0":{"name":"empty"},"stash0":{"name":"empty"},"stash5":{"name":"empty"}},
            "couriers":{"0":{"items":{"item0":{"name":"empty"},"item5":{"name":"empty"}}}}
        });
        let mut worker_pipeline=pipeline::Pipeline::default();
        assert!(worker_pipeline.frame(&before,1,1000,Default::default(),&settings,&sounds).unwrap().sounds.is_empty());
        let first = serde_json::to_value(project(&before).unwrap()).unwrap();
        assert!(!first.to_string().contains("must-not-cross"));
        let mut pending = PendingConfirmations::default();
        assert!(detect_events_with_state(None, &first, 1000, &mut pending).0.is_empty());
        before["abilities"]["ability0"]["cooldown"] = json!(25);
        let planned=worker_pipeline.frame(&before,2,1100,Default::default(),&settings,&sounds).unwrap();
        assert_eq!(planned.sounds.len(),1);
        assert_eq!(planned.sounds[0].event_id,"techies_suicide");
        assert_eq!(planned.sounds[0].asset.file_name,"existing.wav");
        assert_eq!(planned.sounds[0].volume,63);
        assert_eq!(planned.analysis.sound_signals.len(),1);
        let current = serde_json::to_value(project(&before).unwrap()).unwrap();
        let (signals, _) = detect_events_with_state(Some(&first), &current, 1100, &mut pending);
        let resolved = resolve_playback(&signals, &settings.bindings, &settings.assets);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].0, "techies_suicide");
        assert_eq!(assets::read_plugin_file_from(&sounds, resolved[0].1).unwrap(), audio);
        assert!(detect_events_with_state(Some(&current), &current, 1200, &mut pending).0.is_empty());
        assert!(worker_pipeline.frame(&before,3,1200,Default::default(),&settings,&sounds).unwrap().sounds.is_empty());
        assert!(worker_pipeline.frame(&before,3,1200,Default::default(),&settings,&sounds).is_err());
        worker_pipeline.reset();
        assert!(worker_pipeline.frame(&before,1,1300,Default::default(),&settings,&sounds).unwrap().sounds.is_empty());
    }
    assert!(!root.path().join("local-runtime.sqlite3").exists());
    let reopened = config::load_from(&root.path().join("game-sounds-config.json"));
    assert_eq!(settings, reopened);
}

#[test]
fn verified_settings_preserve_existing_file_and_reject_corruption_and_future_schema() {
 let root=tempfile::tempdir().unwrap();let path=root.path().join("game-sounds-config.json");
 assert_eq!(config::load_verified(&path).unwrap(),config::GameSoundSettings::default());
 let mut settings=config::GameSoundSettings::default();settings.master_volume=83;
 config::save_to(&path,&settings).unwrap();assert_eq!(config::load_verified(&path).unwrap(),settings);
 settings.master_volume=42;config::save_to(&path,&settings).unwrap();assert_eq!(config::load_verified(&path).unwrap(),settings);
 for (bytes,error) in [("{","sound_settings_corrupt"),("null","sound_settings_corrupt"),("{\"schemaVersion\":999}","sound_settings_incompatible")] {
  std::fs::write(&path,bytes).unwrap();assert_eq!(config::load_verified(&path).unwrap_err(),error);assert_eq!(std::fs::read_to_string(&path).unwrap(),bytes);
 }
 assert_eq!(std::fs::read_dir(root.path()).unwrap().count(),1);
}
