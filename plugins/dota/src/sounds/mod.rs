//! Existing managed sound configuration/assets and event-to-binding resolution.
//! No Tauri, backend, OBS, stream or match-session dependency.
pub mod config;
pub mod assets;
use companion_dota_domain::events::GameSoundEvent;
pub fn resolve_playback<'a>(
    detected: &[GameSoundEvent],
    bindings: &[config::SoundBinding],
    known_assets: &'a [config::ManagedSoundAsset],
) -> Vec<(String, &'a config::ManagedSoundAsset)> {
    detected
        .iter()
        .filter_map(|event| {
            let binding = bindings.iter().find(|b| b.event_id == event.id && b.kind == event.kind)?;
            let asset = known_assets.iter().find(|a| a.id == binding.asset_id)?;
            Some((event.id.clone(), asset))
        })
        .collect()
}


#[cfg(test)]
mod tests;
pub mod pipeline;
