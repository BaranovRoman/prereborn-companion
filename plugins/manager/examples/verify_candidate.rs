//! Verify a CI-produced archive using ONLY the shipped trust root, without launching it.
use companion_plugin_manager::{Store,Release,TRUSTED_KEY,MAX_PACKAGE,MAX_METADATA};
use std::{fs,path::PathBuf,sync::atomic::AtomicBool};
fn main()->Result<(),Box<dyn std::error::Error>> {
    let args:Vec<_>=std::env::args_os().skip(1).collect();
    if !matches!(args.len(),2|4|5){return Err("usage: verify_candidate ARCHIVE RELEASE_JSON [CATALOG SIGNATURE [PREVIOUS_ARCHIVE]]".into());}
    if fs::metadata(&args[0])?.len()>MAX_PACKAGE||fs::metadata(&args[1])?.len()>MAX_METADATA as u64{return Err("candidate too large".into());}
    let bytes=fs::read(&args[0])?;let release:Release=serde_json::from_slice(&fs::read(&args[1])?)?;
    // Official Windows workers built by the windows-release.yml candidate jobs.
    if !matches!(release.manifest.id.as_str(),"dota2"|"pubg"){return Err("expected an official worker package".into());}
    let id=release.manifest.id.clone();
    let mut catalog=None;
    if args.len()>=4 {
        let signed=companion_plugin_manager::catalog(&fs::read(&args[2])?,&fs::read_to_string(&args[3])?,TRUSTED_KEY)?;
        if !signed.releases.iter().any(|r|serde_json::to_value(r).ok()==serde_json::to_value(&release).ok()){return Err("release not in signed catalog".into());}
        catalog=Some(signed);
    }
    if args.len()==5 {
        // Update from the newest older signed release that this catalog still
        // keeps for existing clients; its bytes are checked against that entry.
        let signed=catalog.as_ref().unwrap();let candidate=semver::Version::parse(&release.manifest.version)?;
        let previous=signed.releases.iter().filter(|r|r.manifest.id==id&&r.manifest.platform==release.manifest.platform&&r.manifest.arch==release.manifest.arch)
            .filter_map(|r|semver::Version::parse(&r.manifest.version).ok().filter(|v|*v<candidate).map(|v|(v,r))).max_by(|a,b|a.0.cmp(&b.0)).map(|(_,r)|r.clone()).ok_or("no older signed release to update from")?;
        if fs::metadata(&args[4])?.len()>MAX_PACKAGE{return Err("previous archive too large".into());}
        let old=fs::read(&args[4])?;let root=tempfile::tempdir()?;
        let mut store=Store::open(root.path().join("plugins"),TRUSTED_KEY)?;
        store.install(&old,&previous,false,&AtomicBool::new(false))?;
        assert!(!store.installed()[&id].enabled,"installation must not enable a live worker");
        // A user who had explicitly enabled the old package keeps that choice;
        // the update itself never enables, prepares or launches anything.
        store.enable(&id,true)?;
        let offered=signed.installable(&store.installed());
        assert!(offered.iter().any(|r|r.manifest.version==release.manifest.version),"catalog must offer the candidate to an installed older version");
        assert!(store.install(&old,&previous,false,&AtomicBool::new(false)).is_err(),"reinstalling the old version must not downgrade");
        store.install(&bytes,&release,false,&AtomicBool::new(false))?;
        let state=&store.installed()[&id];
        assert_eq!(state.active,release.manifest.version);assert_eq!(state.previous.as_deref(),Some(previous.manifest.version.as_str()));assert!(state.pending.is_none());assert!(state.enabled);
        store.verify(&id,&release.manifest.version)?;
        store.install(&bytes,&release,false,&AtomicBool::new(false)).expect_err("same version is not reinstalled");
        println!("Signed update {} -> {} verified; enabled choice kept, nothing launched.",previous.manifest.version,release.manifest.version);
    }
    let root=tempfile::tempdir()?;
    let mut store=Store::open(root.path().join("plugins"),TRUSTED_KEY)?;
    store.install(&bytes,&release,false,&AtomicBool::new(false))?;
    let version=&release.manifest.version;
    let (executable,manifest)=store.executable(&id,version)?;
    assert_eq!(manifest.files,release.manifest.files);
    assert!(!store.installed()[&id].enabled,"installation must not enable a live worker");
    let mut tampered=bytes.clone();let last=tampered.len()-1;tampered[last]^=1;
    assert!(store.install(&tampered,&release,false,&AtomicBool::new(false)).is_err());
    assert_eq!(store.installed()[&id].active,*version);
    // Installed executable revalidation must reject tampering as well.
    fs::write(&executable,b"tampered candidate")?;
    assert!(store.executable(&id,version).is_err());
    store.remove(&id)?;assert!(store.installed().is_empty());drop(store);
    assert!(Store::open(PathBuf::from(root.path()).join("plugins"),TRUSTED_KEY)?.installed().is_empty());
    println!("Official signature/hash, disabled install, tamper rejection, uninstall/reopen verified; no process launched.");
    Ok(())
}
