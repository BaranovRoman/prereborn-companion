// Package-owned settings/catalog contracts. No native API or credentials.
export type GameSoundEventKind = "itemUsed" | "abilityCast";
export type ItemSignal = "cooldown" | "chargesOrConsumed";
// WK-107 - two signals added alongside Techies (real production capture):
// a charge-based ultimate (Proximity Mines) and a toggle ability whose GSI
// `name` itself flips to a "_stop"-suffixed variant while active (Reactive
// Tazer) instead of pulsing a cooldown - see game_sounds/catalog.rs.
export type AbilitySignal = "cooldown" | "charges" | "toggleActivateRename";
// WK-108 - abilities carry a tri-state status instead of a plain boolean:
// `supported` (real production capture proves the signal), `experimental`
// (metadata-plausible, real GSI behavior not verified - see catalog.rs's
// module doc comment for why metadata alone can never earn "supported"),
// `unsupported` (no usable GSI signal exists at all). Items stay a plain
// boolean - that side of the catalog is unchanged by WK-108.
export type AbilityStatus = "supported" | "experimental" | "unsupported";

export interface TrackedItem {
  id: string;
  displayName: string;
  iconUrl: string;
  supported: boolean;
  signal: ItemSignal | null;
  reason: string | null;
}
export interface TrackedAbility {
  id: string;
  displayName: string;
  iconUrl: string;
  status: AbilityStatus;
  signal: AbilitySignal | null;
  // Only set for `toggleActivateRename` abilities - not needed by the UI
  // (bindings always use `id`, the canonical name), present for parity with
  // the Rust catalog shape.
  toggleActiveAlias: string | null;
  reason: string | null;
}
export interface TrackedHero {
  id: string;
  displayName: string;
  iconUrl: string;
  abilities: TrackedAbility[];
}
export interface GameSoundCatalog {
  items: TrackedItem[];
  heroes: TrackedHero[];
}

export interface ManagedSoundAsset {
  id: string;
  fileName: string;
  originalName: string;
  sizeBytes: number;
}
export interface SoundBinding {
  eventId: string;
  kind: GameSoundEventKind;
  assetId: string;
}
export interface GameSoundSettings {
  schemaVersion: number;
  enabled: boolean;
  masterVolume: number;
  bindings: SoundBinding[];
  assets: ManagedSoundAsset[];
}
