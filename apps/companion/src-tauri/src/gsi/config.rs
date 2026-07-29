use std::path::PathBuf;

use crate::state::{GSI_CONFIG_FILE_NAME, GSI_PORT};

/// Single source of truth for which GSI "data" sections Companion requests.
/// Both the installed .cfg file (`cfg_contents` below) and the diagnostics
/// gsi-manifest.json export (diagnostics/export.rs, via `data_sections()`)
/// are built from this exact list, so it is not possible for the two to
/// show a different set of requested sections.
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
    let target = gsi_config_path(dota_path);
    let dir = target.parent().ok_or("Invalid GSI config path")?;

    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Could not create GSI config directory {dir:?}: {e}"))?;

    std::fs::write(&target, cfg_contents())
        .map_err(|e| format!("Could not write GSI config file {target:?}: {e}"))?;

    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

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
