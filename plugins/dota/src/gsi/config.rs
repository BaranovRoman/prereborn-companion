use std::path::PathBuf;

const GSI_PORT:u16=3665;
const GSI_CONFIG_FILE_NAME:&str="gamestate_integration_dota_companion.cfg";

/// Single source of truth for which GSI "data" sections Companion requests.
/// Both the installed .cfg file (`cfg_contents` below) and the diagnostics
/// gsi-manifest.json export (diagnostics/export.rs, via `data_sections()`)
/// are built from this exact list, so it is not possible for the two to
/// show a different set of requested sections.
//
// WK-138 - `couriers` added. Courier state is NOT part of the `items`
// section at all (confirmed via the community GSI schema documentation,
// not assumed) - it is this separate, additively-enabled section, which
// Companion never requested before. Without it, an item sent to/carried by
// courier vanishes from every section this app could see for the entire
// duration the courier holds it - a real, previously-undiagnosed detector
// blind spot behind false "item used" sounds on courier-mediated
// transitions (see game_sounds::events's WK-138 doc comment). Enabling the
// subscription is a safe, additive first step; game_sounds::events does
// NOT parse this section yet - no real production capture with it enabled
// exists yet to confirm its actual field shape, and guessing that shape is
// exactly what this task's audit says not to do. See this task's final
// report for the follow-up this unblocks.
const GSI_DATA_SECTIONS: &[(&str, bool)] = &[
    ("provider", true),
    ("map", true),
    ("player", true),
    ("hero", true),
    ("abilities", true),
    ("items", true),
    ("events", true),
    ("buildings", true),
    ("league", true),
    ("draft", true),
    ("wearables", true),
    ("couriers", true),
];

/// Exposed so diagnostics can report exactly what Companion asked Dota for,
/// without re-declaring the list - see `GSI_DATA_SECTIONS` above.
pub fn data_sections() -> &'static [(&'static str, bool)] {
    GSI_DATA_SECTIONS
}

fn cfg_contents() -> String {
    let data_lines: String = GSI_DATA_SECTIONS
        .iter()
        .map(|(name, enabled)| format!("        \"{name}\"      \"{}\"\n", if *enabled { "1" } else { "0" }))
        .collect();

    format!(
        r#""Dota 2 Companion GSI"
{{
    "uri"           "http://127.0.0.1:{GSI_PORT}"
    "timeout"       "5.0"
    "buffer"        "0.1"
    "throttle"      "0.1"
    "heartbeat"     "30.0"
    "data"
    {{
{data_lines}    }}
}}
"#
    )
}

pub fn gsi_config_path(dota_path: &str) -> PathBuf {
    PathBuf::from(dota_path)
        .join("game")
        .join("dota")
        .join("cfg")
        .join("gamestate_integration")
        .join(GSI_CONFIG_FILE_NAME)
}

/// Writes the GSI config directly into the Dota install — the user should
/// never have to hand-edit this file.
pub fn install_gsi(dota_path: &str) -> Result<PathBuf, String> {
    let root=std::path::Path::new(dota_path).canonicalize().map_err(|_|"dota_directory_unavailable")?;
    if !root.join("game/dota").is_dir(){return Err("dota_directory_invalid".into());}
    let mut directory=root.clone();
    for component in ["game","dota","cfg","gamestate_integration"]{
        directory.push(component);
        match directory.symlink_metadata(){
            Ok(metadata) if metadata.file_type().is_symlink()||!metadata.is_dir()=>return Err("gsi_directory_invalid".into()),
            Ok(_)=>(),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>std::fs::create_dir(&directory).map_err(|_|"gsi_directory_unavailable")?,
            Err(_)=>return Err("gsi_directory_unavailable".into()),
        }
        if !directory.canonicalize().map_err(|_|"gsi_directory_unavailable")?.starts_with(&root){return Err("gsi_directory_invalid".into());}
    }
    let target=directory.join(GSI_CONFIG_FILE_NAME);
    if target.symlink_metadata().is_ok_and(|m|m.file_type().is_symlink()||!m.is_file()){return Err("gsi_config_invalid".into());}

    std::fs::write(&target, cfg_contents())
        .map_err(|e| format!("Could not write GSI config file {target:?}: {e}"))?;

    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_install_writes_the_existing_filename_and_endpoint_only_under_a_real_game_directory(){
        let root=tempfile::tempdir().unwrap();assert!(install_gsi(root.path().to_str().unwrap()).is_err());
        std::fs::create_dir_all(root.path().join("game/dota")).unwrap();
        let path=install_gsi(root.path().to_str().unwrap()).unwrap();assert_eq!(path,gsi_config_path(root.path().canonicalize().unwrap().to_str().unwrap()));
        let data=std::fs::read_to_string(&path).unwrap();assert!(data.contains("http://127.0.0.1:3665"));
        install_gsi(root.path().to_str().unwrap()).unwrap();assert_eq!(std::fs::read_to_string(path).unwrap(),data);
    }
    #[cfg(unix)]
    #[test]
    fn installation_cannot_follow_cfg_links_outside_the_selected_game(){
        let root=tempfile::tempdir().unwrap();let outside=tempfile::tempdir().unwrap();std::fs::create_dir_all(root.path().join("game/dota")).unwrap();
        std::os::unix::fs::symlink(outside.path(),root.path().join("game/dota/cfg")).unwrap();
        assert!(install_gsi(root.path().to_str().unwrap()).is_err());assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(),0);
    }

    #[test]
    fn cfg_contents_still_requests_every_known_section() {
        let text = cfg_contents();
        for (name, enabled) in GSI_DATA_SECTIONS {
            let expected = format!("\"{name}\"      \"{}\"", if *enabled { "1" } else { "0" });
            assert!(text.contains(&expected), "expected {expected:?} in generated cfg:\n{text}");
        }
        // The rest of the config block is untouched by the data_sections refactor.
        assert!(text.contains("\"heartbeat\"     \"30.0\""));
        assert!(text.starts_with("\"Dota 2 Companion GSI\""));
    }

    #[test]
    fn data_sections_is_the_single_source_cfg_contents_reads_from() {
        // Every enabled section in data_sections() must show up as "1" in the
        // generated text, and nothing else - this is the guarantee that
        // gsi-manifest.json (diagnostics/export.rs) can never disagree with
        // the actual installed .cfg.
        let text = cfg_contents();
        for (name, enabled) in data_sections() {
            let value = if *enabled { "1" } else { "0" };
            assert!(text.contains(&format!("\"{name}\"      \"{value}\"")));
        }
    }
}
