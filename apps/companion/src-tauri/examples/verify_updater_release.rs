//! Read-only release gate using the actual configured updater key. Never signs/runs an installer.
use base64::{engine::general_purpose::STANDARD,Engine};
use sha2::{Digest,Sha256};
use std::{fs,path::Path};
fn main()->Result<(),Box<dyn std::error::Error>> {
 let args:Vec<_>=std::env::args().skip(1).collect();
 if !(4..=5).contains(&args.len()){return Err("usage: verify_updater_release INSTALLER MANIFEST TAURI_CONFIG EXPECTED_VERSION [INSTALLED_VERSION]".into());}
 let installer=Path::new(&args[0]);let bytes=fs::read(installer)?;
 let manifest:serde_json::Value=serde_json::from_slice(&fs::read(&args[1])?)?;
 let config:serde_json::Value=serde_json::from_slice(&fs::read(&args[2])?)?;
 if manifest["version"].as_str()!=Some(&args[3]){return Err("manifest version mismatch".into());}
 if let Some(installed)=args.get(4) {
  let release:tauri_plugin_updater::RemoteRelease=serde_json::from_value(manifest.clone())?;
  let mut baseline=manifest.clone();baseline["version"]=installed.clone().into();
  let baseline:tauri_plugin_updater::RemoteRelease=serde_json::from_value(baseline)?;
  if release.version<=baseline.version{return Err("updater would not offer this version".into());}
 }
 let platform=&manifest["platforms"]["windows-x86_64"];
 let signature=platform["signature"].as_str().ok_or("signature missing")?;
 let stored=fs::read_to_string(format!("{}.sig",installer.display()))?;
 if signature!=stored.trim(){return Err("manifest/sidecar signature mismatch".into());}
 let key=config["plugins"]["updater"]["pubkey"].as_str().ok_or("key missing")?;
 let signature=String::from_utf8(STANDARD.decode(signature)?)?;
 let key=String::from_utf8(STANDARD.decode(key)?)?;
 companion_plugin_manager::verify_signature(&bytes,&signature,&key)?;
 let checksum=fs::read_to_string(format!("{}.sha256",installer.display()))?;
 let actual=format!("{:x}",Sha256::digest(&bytes));
 if checksum.split_whitespace().next()!=Some(&actual){return Err("checksum mismatch".into());}
 let expected=format!("https://github.com/BaranovRoman/prereborn-companion/releases/download/prereborn-v{}/{}",args[3],installer.file_name().ok_or("name missing")?.to_str().ok_or("invalid filename")?.replace(' ',"."));
 if platform["url"].as_str()!=Some(&expected){return Err("manifest URL mismatch".into());}
 println!("Verified {}: configured-key signature, manifest URL/version/sidecar, SHA256",args[3]);Ok(())
}
