//! Verify a CI-produced archive using ONLY the shipped trust root, without launching it.
use companion_plugin_manager::{Store,Release,TRUSTED_KEY,MAX_PACKAGE,MAX_METADATA};
use std::{fs,path::PathBuf,sync::atomic::AtomicBool};
fn main()->Result<(),Box<dyn std::error::Error>> {
    let args:Vec<_>=std::env::args_os().skip(1).collect();
    if args.len()!=2{return Err("usage: verify_candidate ARCHIVE RELEASE_JSON".into());}
    if fs::metadata(&args[0])?.len()>MAX_PACKAGE||fs::metadata(&args[1])?.len()>MAX_METADATA as u64{return Err("candidate too large".into());}
    let bytes=fs::read(&args[0])?;let release:Release=serde_json::from_slice(&fs::read(&args[1])?)?;
    if release.manifest.id!="dota2"{return Err("expected dota2".into());}
    let root=tempfile::tempdir()?;
    let mut store=Store::open(root.path().join("plugins"),TRUSTED_KEY)?;
    store.install(&bytes,&release,false,&AtomicBool::new(false))?;
    let id=&release.manifest.id;let version=&release.manifest.version;
    let (executable,manifest)=store.executable(id,version)?;
    assert_eq!(manifest.files,release.manifest.files);
    assert!(!store.installed()[id].enabled,"installation must not enable Dota");
    let mut tampered=bytes.clone();let last=tampered.len()-1;tampered[last]^=1;
    assert!(store.install(&tampered,&release,false,&AtomicBool::new(false)).is_err());
    assert_eq!(store.installed()[id].active,*version);
    // Installed executable revalidation must reject tampering as well.
    fs::write(&executable,b"tampered candidate")?;
    assert!(store.executable(id,version).is_err());
    store.remove(id)?;assert!(store.installed().is_empty());drop(store);
    assert!(Store::open(PathBuf::from(root.path()).join("plugins"),TRUSTED_KEY)?.installed().is_empty());
    println!("Official signature/hash, disabled install, tamper rejection, uninstall/reopen verified; no process launched.");
    Ok(())
}
