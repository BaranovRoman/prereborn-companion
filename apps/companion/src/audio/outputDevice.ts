// Reliability follow-up - selectable audio output device for Twitch chat TTS
// and Companion alert/notification sounds. No Rust/native audio backend
// exists in this app (see the feature's research note: every sound plays via
// a plain `<audio>`/AudioContext element in the frontend webview - Rust only
// ever produces bytes). Device enumeration + routing therefore uses the
// standard Web APIs the Chromium-based WebView2 runtime already exposes
// (`navigator.mediaDevices.enumerateDevices` + `HTMLMediaElement.setSinkId`/
// `AudioContext.setSinkId`), rather than adding a native audio crate.
//
// Deliberately plain functions + localStorage (mirrors useOverallVolume.ts/
// ChatSettings' own pattern), not a Rust-persisted settings file: this is a
// UI/webview-scoped concern with zero Rust-side involvement, so there is
// nothing for a Rust settings file to own.

export interface OutputDeviceOption {
  deviceId: string;
  label: string;
}

export type OutputDeviceSelection =
  | { mode: "system-default" }
  | { mode: "explicit"; deviceId: string; label: string };

export interface DefaultDeviceSignature {
  groupId: string;
  label: string;
}

const SELECTION_STORAGE_KEY = "companion-audio-output-device-v1";
const LAST_DEFAULT_STORAGE_KEY = "companion-audio-output-last-default-v1";
const PROMPTED_DEFAULT_STORAGE_KEY = "companion-audio-output-prompted-default-v1";
const ACKED_DEFAULT_STORAGE_KEY = "companion-audio-output-acked-default-v1";

export const SYSTEM_DEFAULT_SELECTION: OutputDeviceSelection = { mode: "system-default" };

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort persistence - a blocked/full localStorage must not crash
    // playback, it just won't survive a restart (mirrors useOverallVolume.ts).
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export function loadSelection(): OutputDeviceSelection {
  const stored = readJson<OutputDeviceSelection>(SELECTION_STORAGE_KEY);
  if (!stored || typeof stored !== "object") return SYSTEM_DEFAULT_SELECTION;
  if (stored.mode === "system-default") return SYSTEM_DEFAULT_SELECTION;
  if (stored.mode === "explicit" && typeof stored.deviceId === "string" && stored.deviceId.length > 0) {
    return { mode: "explicit", deviceId: stored.deviceId, label: typeof stored.label === "string" ? stored.label : stored.deviceId };
  }
  return SYSTEM_DEFAULT_SELECTION;
}

export function saveSelection(selection: OutputDeviceSelection): void {
  writeJson(SELECTION_STORAGE_KEY, selection);
}

export function loadLastSeenDefault(): DefaultDeviceSignature | null {
  return readJson<DefaultDeviceSignature>(LAST_DEFAULT_STORAGE_KEY);
}

export function saveLastSeenDefault(signature: DefaultDeviceSignature): void {
  writeJson(LAST_DEFAULT_STORAGE_KEY, signature);
}

export function loadPromptedSignature(): DefaultDeviceSignature | null {
  return readJson<DefaultDeviceSignature>(PROMPTED_DEFAULT_STORAGE_KEY);
}

export function savePromptedSignature(signature: DefaultDeviceSignature): void {
  writeJson(PROMPTED_DEFAULT_STORAGE_KEY, signature);
}

export function loadAckedSignature(): DefaultDeviceSignature | null {
  return readJson<DefaultDeviceSignature>(ACKED_DEFAULT_STORAGE_KEY);
}

export function saveAckedSignature(signature: DefaultDeviceSignature): void {
  writeJson(ACKED_DEFAULT_STORAGE_KEY, signature);
}

export function clearAudioOutputDeviceStorage(): void {
  removeKey(SELECTION_STORAGE_KEY);
  removeKey(LAST_DEFAULT_STORAGE_KEY);
  removeKey(PROMPTED_DEFAULT_STORAGE_KEY);
  removeKey(ACKED_DEFAULT_STORAGE_KEY);
}

export function sameSignature(a: DefaultDeviceSignature | null, b: DefaultDeviceSignature | null): boolean {
  if (a === null || b === null) return a === b;
  return a.groupId === b.groupId && a.label === b.label;
}

// Real, individually pickable output devices - excludes the synthetic
// "default"/"communications" aggregate entries Chromium adds, which mirror
// whatever the real default device currently is rather than being separate
// setSinkId targets themselves (see findRealDeviceForDefault below for how a
// physical device behind "default" is resolved when needed).
export function toOutputDeviceOptions(devices: MediaDeviceInfo[]): OutputDeviceOption[] {
  return devices
    .filter((d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d) => ({ deviceId: d.deviceId, label: d.label || `Устройство ${d.deviceId.slice(0, 6)}` }));
}

export function findSystemDefaultSignature(devices: MediaDeviceInfo[]): DefaultDeviceSignature | null {
  const entry = devices.find((d) => d.kind === "audiooutput" && d.deviceId === "default");
  if (!entry) return null;
  return { groupId: entry.groupId, label: entry.label || "Системное устройство" };
}

// Resolves the REAL physical device currently backing "default" (matched by
// shared groupId, Chromium's own linkage between the alias and the concrete
// device), so pinning "the device that's default right now" as an explicit
// choice survives a LATER default change instead of just re-aliasing to the
// literal "default" sink id every time.
export function findRealDeviceForDefault(devices: MediaDeviceInfo[]): OutputDeviceOption | null {
  const defaultEntry = devices.find((d) => d.kind === "audiooutput" && d.deviceId === "default");
  if (!defaultEntry) return null;
  const real = devices.find(
    (d) => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications" && d.groupId === defaultEntry.groupId
  );
  if (real) return { deviceId: real.deviceId, label: real.label || defaultEntry.label || "Системное устройство" };
  // Labels not unlocked yet / no matching groupId found - fall back to the
  // literal "default" sink id, which setSinkId itself accepts as valid.
  return { deviceId: "default", label: defaultEntry.label || "Системное устройство" };
}

export function isSelectedDeviceMissing(selection: OutputDeviceSelection, devices: MediaDeviceInfo[]): boolean {
  if (selection.mode !== "explicit") return false;
  if (selection.deviceId === "default") return false; // the literal alias is always a valid sink id
  return !devices.some((d) => d.kind === "audiooutput" && d.deviceId === selection.deviceId);
}

let labelsUnlockAttempted = false;

// Chromium only reveals real deviceId/label values for enumerateDevices()
// once ANY media permission has been granted (fingerprinting protection) -
// this applies to audiooutput labels too, not just audioinput/video. Runs at
// most once per app session; failure (denied/unavailable) is silent and
// leaves devices addressable by deviceId with a generic fallback label (see
// toOutputDeviceOptions) rather than blocking the picker.
export async function ensureDeviceLabelsUnlocked(): Promise<void> {
  if (labelsUnlockAttempted) return;
  labelsUnlockAttempted = true;
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasHiddenLabels = devices.some((d) => d.kind === "audiooutput" && !d.label);
    if (!hasHiddenLabels) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch {
    // Permission denied/unavailable - device labels stay generic.
  }
}

export function resetLabelsUnlockedForTests(): void {
  labelsUnlockAttempted = false;
}

export async function listOutputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  return navigator.mediaDevices.enumerateDevices();
}

type SinkCapableElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

// Called fire-and-forget (never awaited before `.play()`) right after
// creating every `<audio>` element Companion uses for Twitch chat TTS
// (Silero) / Custom Game Sounds alerts (see useTwitchChatSession.ts,
// useDraftStreamReminder.ts, useGameSoundEngine.ts) - routing to the
// selected device must never delay when playback actually starts, matching
// this codebase's existing "never block playback" policy for audio errors.
// A missing pinned device (NotFoundError) is deliberately not thrown
// further: the element still plays via whatever the browser resolves as the
// actual output - that IS the safe, non-silent fallback the task calls for,
// made visible separately via useAudioOutputDevice's periodic enumeration
// (see that hook's `selectedDeviceMissing`), not by blocking playback here.
export async function applySinkId(element: HTMLMediaElement): Promise<"applied" | "unsupported" | "missing"> {
  const selection = loadSelection();
  if (selection.mode !== "explicit") return "unsupported";
  const target = element as SinkCapableElement;
  if (typeof target.setSinkId !== "function") return "unsupported";
  try {
    await target.setSinkId(selection.deviceId);
    return "applied";
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "NotFoundError") return "missing";
    return "unsupported";
  }
}

type SinkCapableAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

// Same idea as applySinkId, for the raw-AudioContext "new chat message" beep
// (useTwitchChatSession.ts's beep()). Best-effort only: AudioContext.setSinkId
// is a newer addition than HTMLMediaElement.setSinkId and may not exist on
// every WebView2 build Companion ships against - failure here must never
// block the beep itself.
export async function applyAudioContextSinkId(context: AudioContext): Promise<void> {
  const selection = loadSelection();
  if (selection.mode !== "explicit") return;
  const target = context as SinkCapableAudioContext;
  if (typeof target.setSinkId !== "function") return;
  try {
    await target.setSinkId(selection.deviceId);
  } catch {
    // Best-effort - see applySinkId's doc comment for the general policy.
  }
}
