use super::*;
fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../plugins/target/debug")
        .join(if cfg!(windows) {"companion-dota-plugin.exe"} else {"companion-dota-plugin"})
}
fn wait(observer: &Observer, predicate: impl Fn(&Status)->bool) -> Status {
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let status = observer.status();
        if predicate(&status) { return status; }
        assert!(Instant::now() < deadline, "observer status: {}", serde_json::to_string(&status).unwrap());
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn raw(charges:i64, hero:i64) -> Value {
    json!({"auth":{"token":"SECRET"},"provider":{"steamid":"SECRET"},
        "player":{"activity":"playing","steamid":"SECRET","name":"SECRET","team_name":"radiant"},
        "map":{"game_state":"DOTA_GAMERULES_STATE_GAME_IN_PROGRESS","matchid":42},
        "hero":{"id":hero},"items":{"slot0":{"name":"item_tango","charges":charges}}})
}
#[test]
fn production_and_default_do_not_enable_observer() {
    let args=vec!["--dota-gsi-observer".into()];
    assert!(!enabled(false,&args));assert!(!enabled(true,&[]));assert!(enabled(true,&args));
}
#[test]
fn bounded_projection_strips_metadata_without_changing_pure_results() {
    let mut original=raw(3,105);
    original["couriers"]=json!({"SECRET":{"steamid":"SECRET","items":{"slot0":{"name":"item_flask"}}}});
    original["map"]["customgamename"]=json!("fixture_custom_game");
    let projected=serde_json::to_value(project(&original).unwrap()).unwrap();
    assert_eq!(gsi::parse(&original),gsi::parse(&projected));
    assert!(!projected.to_string().contains("SECRET"));
    assert_eq!(BroadcastState::from_gsi(&original),BroadcastState::from_gsi(&projected));
    assert_eq!(events::detect_events(Some(&original),&raw(2,105)),events::detect_events(Some(&projected),&serde_json::to_value(project(&raw(2,105)).unwrap()).unwrap()));
    let slots:serde_json::Map<_,_>=(0..33).map(|i|(format!("slot{i}"),json!({}))).collect();
    assert!(project(&json!({"items":slots})).is_err());
    assert!(project(&json!({"player":{"activity":"x".repeat(129)}})).is_err());
}
#[test]
fn external_semantic_parity_states_heroes_sounds_partial_postgame_and_reset() {
    let observer=Observer::new(binary());observer.start().unwrap();
    assert_eq!(observer.start().unwrap_err(),"already_started");
    let mut frames=vec![json!({}),json!({"player":{"activity":"playing"},"map":{"game_state":"DOTA_GAMERULES_STATE_HERO_SELECTION"}}),raw(3,105),raw(2,105),raw(1,106),json!({"hero":{"id":106}}),json!({"map":{"game_state":"DOTA_GAMERULES_STATE_POST_GAME","matchid":42}})];
    for (index,frame) in frames.drain(..).enumerate() {
        observer.submit(&frame,ReplayContext::default());
        let status=wait(&observer,|s|s.processed==index as u64+1);
        assert_eq!(status.parity_mismatches,0);
        if index==3 {assert_eq!(status.last_analysis.unwrap()["soundSignals"][0]["id"],"item_tango");}
    }
    observer.0.last_time.store(0,Ordering::SeqCst);
    // Explicit discontinuity models reconnect independently from a real five-second wait.
    observer.0.generation.fetch_add(1,Ordering::SeqCst);
    observer.submit(&raw(0,106),ReplayContext::default());
    let status=wait(&observer,|s|s.processed==8);
    assert!(status.last_analysis.unwrap()["soundSignals"].as_array().unwrap().is_empty());
    assert!(status.resets>=2);
    observer.submit(&raw(0,106),ReplayContext{session_ended:true,..Default::default()});
    let status=wait(&observer,|s|s.processed==9);
    assert_eq!(status.last_analysis.unwrap()["broadcastState"],"postStream");
    observer.stop();wait(&observer,|s|s.phase=="stopped");
    observer.start().unwrap();observer.submit(&raw(0,105),ReplayContext::default());
    let status=wait(&observer,|s|s.processed==10);assert_eq!(status.parity_mismatches,0);
    assert!(status.last_analysis.unwrap()["soundSignals"].as_array().unwrap().is_empty());observer.stop();
}
#[test]
fn try_lock_drop_and_overflow_invalidate_history_and_bound_backlog() {
    // No process can consume this mailbox; assert producer policy deterministically.
    let shared=Arc::new(Shared{queue:Mutex::new(VecDeque::new()),status:Mutex::new(Status::default()),wanted:AtomicBool::new(true),generation:AtomicU64::new(1),sequence:AtomicU64::new(0),lost:AtomicU64::new(0),sent:AtomicU64::new(0),last_time:AtomicU64::new(0),origin:Instant::now()});
    let observer=Observer(shared);
    for _ in 0..CAPACITY+1 {observer.submit(&raw(3,105),ReplayContext::default());}
    assert_eq!(observer.0.queue.lock().unwrap().len(),1);assert_eq!(observer.status().lost,CAPACITY as u64);
    let before=observer.0.generation.load(Ordering::SeqCst);
    let guard=observer.0.queue.lock().unwrap();let started=Instant::now();observer.submit(&raw(1,105),ReplayContext::default());
    assert!(started.elapsed()<Duration::from_secs(1));drop(guard);
    assert!(observer.0.generation.load(Ordering::SeqCst)>before);assert_eq!(observer.status().lost,CAPACITY as u64+1);
}
#[test]
fn duplicate_out_of_order_frames_are_dropped_before_analysis() {
    let observer=Observer::new(binary());observer.start().unwrap();observer.submit(&raw(3,105),ReplayContext::default());wait(&observer,|s|s.processed==1);
    let generation=observer.0.generation.load(Ordering::SeqCst);
    let input=ReplayInput{sequence:1,observed_at_ms:0,snapshot:project(&raw(1,105)).unwrap(),context:ReplayContext::default()};
    observer.0.queue.lock().unwrap().push_back(Frame{generation,input});
    wait(&observer,|s|s.lost==1);
    observer.submit(&raw(1,105),ReplayContext::default());let status=wait(&observer,|s|s.processed==2);
    assert!(status.last_analysis.unwrap()["soundSignals"].as_array().unwrap().is_empty());assert_eq!(status.parity_mismatches,0);observer.stop();
}
#[test]
fn failed_launch_can_be_started_again_without_another_runtime() {
    let observer=Observer::new(PathBuf::from("/nonexistent-observer"));observer.start().unwrap();
    wait(&observer,|s|s.phase=="failed");observer.start().unwrap();wait(&observer,|s|s.phase=="failed");observer.stop();
}
#[cfg(unix)]
#[test]
fn hung_or_crashed_process_cannot_block_ingest_and_requires_explicit_restart() {
    use std::os::unix::fs::PermissionsExt;
    for tail in ["exec /bin/sleep 30", "exit 1"] {
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("observer");
        std::fs::write(&path,format!("#!/bin/sh\nprintf '%s\\n' '{{\"protocol\":1,\"message\":{{\"type\":\"ready\",\"id\":\"dota2\",\"version\":\"0.1.0\",\"min_core_api\":1,\"max_core_api\":1}}}}'\n{tail}\n")).unwrap();
        std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).unwrap();
        let observer=Observer::new(path);observer.start().unwrap();
        let before=Instant::now();for _ in 0..100 {observer.submit(&raw(3,105),ReplayContext::default());}
        assert!(before.elapsed()<Duration::from_secs(1));wait(&observer,|s|s.phase=="failed");
        assert!(!observer.0.wanted.load(Ordering::SeqCst));assert!(observer.0.queue.lock().unwrap().is_empty());
        observer.start().unwrap();observer.submit(&raw(3,105),ReplayContext::default());wait(&observer,|s|s.phase=="failed");observer.stop();
    }
}

#[cfg(unix)]
#[test]
fn semantic_mismatch_is_visible_but_untrusted_payload_never_exposed() {
    use std::os::unix::fs::PermissionsExt;
    let dir=tempfile::tempdir().unwrap();let path=dir.path().join("mismatch");
    std::fs::write(&path, r#"#!/bin/sh
printf '%s\n' '{"protocol":1,"message":{"type":"ready","id":"dota2","version":"0.1.0","min_core_api":1,"max_core_api":1}}'
while IFS= read -r frame; do
 case "$frame" in
 *'"name":"dota.reset"'*) printf '%s\n' '{"protocol":1,"message":{"type":"reply","id":1,"result":{"reset":true}}}' ;;
 *'"name":"dota.replay"'*) printf '%s\n' '{"protocol":1,"message":{"type":"reply","id":2,"result":{"secret":"SECRET","sideEffects":true}}}' ;;
 *'"type":"stop"'*) printf '%s\n' '{"protocol":1,"message":{"type":"stopped"}}'; exit 0 ;;
 esac
done
"#).unwrap();
    std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).unwrap();
    let observer=Observer::new(path);observer.start().unwrap();observer.submit(&raw(3,105),ReplayContext::default());
    let status=wait(&observer,|s|s.processed==1);
    assert_eq!(status.parity_mismatches,1);assert_eq!(status.last_error,Some("parity_mismatch"));
    assert!(status.last_analysis.is_none());assert!(!serde_json::to_string(&status).unwrap().contains("SECRET"));observer.shutdown();
}

#[test]
fn ability_and_courier_signals_match_across_the_process_boundary() {
    let observer=Observer::new(binary());observer.start().unwrap();
    let mut a=raw(3,14);a["abilities"]=json!({"ability0":{"name":"pudge_meat_hook","cooldown":0}});
    a["couriers"]=json!({"0":{"items":{"slot0":{"name":"item_flask","charges":1}}}});
    observer.submit(&a,ReplayContext::default());wait(&observer,|s|s.processed==1);
    a["abilities"]["ability0"]["cooldown"]=json!(12);a["items"]=json!({});
    observer.submit(&a,ReplayContext::default());let status=wait(&observer,|s|s.processed==2);
    assert_eq!(status.parity_mismatches,0);
    assert_eq!(status.last_analysis.unwrap()["soundSignals"][0]["id"],"pudge_meat_hook");observer.shutdown();
}

#[test]
fn dropped_frames_reset_the_real_worker_before_next_analysis() {
    let observer=Observer::new(binary());observer.start().unwrap();observer.submit(&raw(3,105),ReplayContext::default());
    wait(&observer,|s|s.processed==1);
    // Force a nonblocking mailbox rejection at precisely the ingest boundary.
    let guard=observer.0.queue.lock().unwrap();observer.submit(&raw(2,105),ReplayContext::default());drop(guard);
    observer.submit(&raw(1,105),ReplayContext::default());
    let status=wait(&observer,|s|s.last_sequence==3);
    assert_eq!(status.lost,1);assert_eq!(status.processed,2);assert_eq!(status.parity_mismatches,0);
    assert_eq!(status.resets,2);assert!(status.last_analysis.unwrap()["soundSignals"].as_array().unwrap().is_empty());observer.shutdown();
}
