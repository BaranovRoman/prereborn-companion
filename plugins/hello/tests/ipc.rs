use companion_plugin_protocol::runtime::Runtime;
use serde_json::json;
#[test]
fn api1_and_api2_handshakes_keep_hello_ui_only_and_do_not_grant_host_access(){
 let path=std::path::Path::new(env!("CARGO_BIN_EXE_companion-hello-plugin"));
 for api in [1,2]{
  let mut runtime=Runtime::default();runtime.start_expected_api(path,&[],"hello",Some(env!("CARGO_PKG_VERSION")),api).unwrap();
  assert_eq!(runtime.command("greet".into(),json!({"text":"versioned"})).unwrap()["text"],"Hello, versioned!");
  assert!(runtime.command("host.activate".into(),json!({})).is_err());runtime.stop().unwrap();runtime.stopped_confirmed().unwrap();
 }
 let mut runtime=Runtime::default();assert_eq!(runtime.start_expected_api(path,&[],"hello",None,99).unwrap_err(),"incompatible_plugin");
}
