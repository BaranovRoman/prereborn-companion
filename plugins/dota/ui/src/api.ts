import { client } from "../../../protocol/ui";
import type { GameSoundCatalog, GameSoundSettings, ManagedSoundAsset, SoundBinding, TrackedHero, TrackedItem } from "./services/dotaCompanionApi";

export const bridge = client();
export async function invoke<T>(name: string, args: unknown = {}): Promise<T> {
  await bridge.connection;
  return bridge.invoke<T>(name,args);
}
interface Summary extends Omit<GameSoundSettings,"bindings"|"assets"> { bindings: number; assets: number; revision: string }
async function pages<T>(name: string, size: number, max: number, field: string): Promise<T[]> {
  const all: T[] = []; let total = 1;
  while (all.length < total) {
    const result = await invoke<{total: number; [key: string]: unknown}>(name,{offset:all.length,limit:size});
    const items = result[field];
    if (!Number.isSafeInteger(result.total) || result.total < 0 || result.total > max || !Array.isArray(items) || items.length > size || (!items.length && all.length < result.total)) throw new Error("invalid_catalog_page");
    total = result.total; all.push(...items as T[]);
  }
  return all;
}
export async function catalog(): Promise<GameSoundCatalog> {
  const [items,heroes] = await Promise.all([pages<TrackedItem>("catalog.items",32,2048,"items"),pages<TrackedHero>("catalog.heroes",4,256,"heroes")]);
  return {items,heroes};
}
export async function settings(): Promise<GameSoundSettings> {
  const summary = await invoke<Summary>("sound.summary");
  if (![summary.bindings,summary.assets].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 10000) || !/^[0-9a-f]{64}$/.test(summary.revision)) throw new Error("invalid_settings_summary");
  async function read<T>(name: string, count: number): Promise<T[]> {
    const result: T[] = [];
    while (result.length < count) {
      const page = await invoke<{items:T[]; revision:string}>(name,{offset:result.length,limit:32,revision:summary.revision});
      if (page.revision !== summary.revision || !Array.isArray(page.items) || !page.items.length || page.items.length > 32 || result.length + page.items.length > count) throw new Error("sound_settings_changed");
      result.push(...page.items);
    }
    return result;
  }
  const [bindings,assets] = await Promise.all([read<SoundBinding>("sound.bindings",summary.bindings),read<ManagedSoundAsset>("sound.assets",summary.assets)]);
  return {schemaVersion:summary.schemaVersion,enabled:summary.enabled,masterVolume:summary.masterVolume,bindings,assets};
}
export interface Status {
  overlayVisible?:boolean;showSummary?:boolean;
  prepared: boolean; active: boolean; awaitingSession: boolean; session: string|null; epoch: number|null;
  lastError: string|null; processed: number; lastSequence: number|null;
  gsi: {received:number;accepted:number;rejected:number;dropped:number;lastError:string|null}|null;
  detectedSounds?:number;plannedSounds?:number;droppedSoundIntents?:number;lastSoundOperation?:string|null;
  streaming?:boolean|null;streamEnded?:boolean;backendError?:string|null;backendUpdates?:number;obsError?:string|null;
}
export interface AudioReceipt {receipt:{status:"queued"|"playing"|"completed"|"cancelled"|"unknown";operationKey:string}|null}
export interface Match { localId:string;matchId:string|null;heroId:number;state:string;result:string|null;kills:number|null;deaths:number|null;assists:number|null;startedAt:string;ratingAfter:number|null;detectedRatingDelta?:number|null;ratingDeltaCorrection?:number;rankedMode?:"ranked"|"unranked"|"unknown";rankedModeDetected?:"ranked"|"unranked"|"unknown" }
export interface History {hasSession:boolean;ratingCurrent:number|null;wins:number;losses:number;currentMatch:Match|null;recentMatches:Match[]}
export interface GsiInstallation {found:boolean;path?:string;installed:boolean}
export interface SyncStatus{pendingCount:number;retryingCount:number;failedCount:number;unknownDeliveryCount:number;lastDeliveredAt:string|null;lastError:string|null}
export type HistoryEdit = {kind:"rating";rating:number}|{kind:"match_delta";local_id:string;delta:number|null}|{kind:"match_mode";local_id:string;ranked:boolean|null}|{kind:"continue_session"|"end_session"|"recover_interrupted"};
export interface EditContext {revision:number;session:string|null;active:boolean}
export interface EditReceipt {operationKey:string;beforeRevision:number;revision:number;resolvedSession:string|null;streamEnded:boolean}
