// Package-owned contracts and protected bridge clients. No Tauri API or credentials.
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

// Protected host bridge only; no Tauri access in the package iframe.
import {invoke} from "../api";
import {readBackendResource,getQueueSettings,saveQueueSettings} from "../overlayApi";
export type LocalMatchResultValue="win"|"loss"|"abandon";
export interface HeroLocalStats{matches:number;wins:number;losses:number;avgKills:number|null;avgDeaths:number|null;avgAssists:number|null;recentResults:LocalMatchResultValue[]}
export const getHeroLocalStats=(heroId:number)=>invoke<HeroLocalStats>("history.hero",{heroId});
export const getFavoriteHeroes=()=>getQueueSettings().then(settings=>settings.favoriteHeroIds);
export async function saveFavoriteHeroes(heroIds:number[]){
 if(heroIds.length>3||new Set(heroIds).size!==heroIds.length||heroIds.some(id=>!Number.isSafeInteger(id)||id<=0))throw Error("invalid_favorite_heroes");
 const settings=await getQueueSettings();return (await saveQueueSettings({...settings,favoriteHeroIds:heroIds})).favoriteHeroIds;
}
export type HeroOpenDotaStats =
  | {
      status: "ok";
      source: "opendota";
      heroId: number;
      games: number;
      wins: number;
      losses: number;
      winRate: number | null;
      fetchedAt: string;
    }
  | { status: "steam_not_connected" }
  | { status: "no_data" }
  | { status: "rate_limited" }
  | { status: "unavailable" };
export const getHeroOpenDotaStats = (heroId: number) =>
  readBackendResource<HeroOpenDotaStats>("hero-stats", { id:String(heroId) });

// WK-148 - additive enrichment atop HeroOpenDotaStats above (recent form /
// current-patch W-L / KDA-GPM-XPM / best-effort ranking). Each sub-field is
// independently nullable - a partial upstream failure degrades that one
// field, not the whole panel (mirrors apps/api's
// OpenDotaHeroInsightsResponse in controllers/stream/opendota.ts).
export type HeroOpenDotaInsights =
  | {
      status: "ok";
      source: "opendota";
      heroId: number;
      recentForm: { sample: number; wins: number; losses: number; winRate: number } | null;
      patch: {
        patchId: number;
        patchName: string | null;
        // WK-148 polish - true only when confirmed to be OpenDota's current
        // known patch, not just the newest one this player has played.
        isLatestKnown: boolean;
        games: number;
        wins: number;
        losses: number;
        winRate: number;
      } | null;
      kills: number | null;
      deaths: number | null;
      assists: number | null;
      goldPerMin: number | null;
      xpPerMin: number | null;
      heroDamage: number | null;
      towerDamage: number | null;
      heroHealing: number | null;
      rankPercent: number | null;
      fetchedAt: string;
    }
  | { status: "steam_not_connected" }
  | { status: "no_data" }
  | { status: "rate_limited" }
  | { status: "unavailable" };
export const getHeroOpenDotaInsights = (heroId: number) =>
  readBackendResource<HeroOpenDotaInsights>("hero-insights", { id:String(heroId) });
