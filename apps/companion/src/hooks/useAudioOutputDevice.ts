import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureDeviceLabelsUnlocked,
  findRealDeviceForDefault,
  findSystemDefaultSignature,
  isSelectedDeviceMissing,
  listOutputDevices,
  loadAckedSignature,
  loadLastSeenDefault,
  loadPromptedSignature,
  loadSelection,
  sameSignature,
  saveAckedSignature,
  saveLastSeenDefault,
  savePromptedSignature,
  saveSelection,
  toOutputDeviceOptions,
  type DefaultDeviceSignature,
  type OutputDeviceOption,
  type OutputDeviceSelection,
} from "../audio/outputDevice";

export interface AudioOutputDeviceState {
  devices: OutputDeviceOption[];
  selection: OutputDeviceSelection;
  setSelection: (next: OutputDeviceSelection) => void;
  // The explicit device currently selected has disappeared from the system -
  // higher-priority than the default-changed notice below (п.1/п.2 "если
  // пропадает именно выбранное устройство").
  selectedDeviceMissing: boolean;
  selectedDeviceLabel: string | null;
  // "System default" mode: Windows default changed - informational only.
  defaultDeviceChangedNotice: string | null;
  dismissDefaultDeviceChangedNotice: () => void;
  // Explicit-device mode: Windows default changed - ask before moving.
  switchPrompt: { toLabel: string } | null;
  onSwitchToNewDefault: () => void;
  onKeepCurrentDevice: () => void;
}

// Safety net alongside the `devicechange` event: some WebView2 builds don't
// reliably fire it for every default-device change, matching the existing
// codebase's own "poll + event" pattern (useStatus.ts/useLocalLifecycle.ts).
const POLL_INTERVAL_MS = 5000;

export function useAudioOutputDevice(): AudioOutputDeviceState {
  const [selection, setSelectionState] = useState<OutputDeviceSelection>(loadSelection);
  const [rawDevices, setRawDevices] = useState<MediaDeviceInfo[]>([]);
  const [hasEnumerated, setHasEnumerated] = useState(false);
  const [defaultChangedNotice, setDefaultChangedNotice] = useState<string | null>(null);
  const [switchPrompt, setSwitchPrompt] = useState<{ toLabel: string; signature: DefaultDeviceSignature } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const refreshDevices = useCallback(async () => {
    await ensureDeviceLabelsUnlocked();
    const devices = await listOutputDevices();
    setRawDevices(devices);
    setHasEnumerated(true);

    const currentSignature = findSystemDefaultSignature(devices);
    if (!currentSignature) return;
    const lastSeen = loadLastSeenDefault();
    if (sameSignature(currentSignature, lastSeen)) return;
    saveLastSeenDefault(currentSignature);
    // Only a genuine change (not the very first observation this run) is
    // worth telling the user about.
    if (lastSeen === null) return;

    if (selectionRef.current.mode === "system-default") {
      const acked = loadAckedSignature();
      if (!sameSignature(acked, currentSignature)) {
        setDefaultChangedNotice(`Системный вывод сменился на «${currentSignature.label}».`);
      }
    } else {
      const prompted = loadPromptedSignature();
      if (!sameSignature(prompted, currentSignature)) {
        setSwitchPrompt({ toLabel: currentSignature.label, signature: currentSignature });
      }
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    const timer = window.setInterval(() => void refreshDevices(), POLL_INTERVAL_MS);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      window.clearInterval(timer);
    };
  }, [refreshDevices]);

  const setSelection = useCallback((next: OutputDeviceSelection) => {
    setSelectionState(next);
    saveSelection(next);
  }, []);

  const dismissDefaultDeviceChangedNotice = useCallback(() => {
    const currentSignature = findSystemDefaultSignature(rawDevices);
    if (currentSignature) saveAckedSignature(currentSignature);
    setDefaultChangedNotice(null);
  }, [rawDevices]);

  const onSwitchToNewDefault = useCallback(() => {
    if (!switchPrompt) return;
    const real = findRealDeviceForDefault(rawDevices);
    if (real) setSelection({ mode: "explicit", deviceId: real.deviceId, label: real.label });
    savePromptedSignature(switchPrompt.signature);
    setSwitchPrompt(null);
  }, [switchPrompt, rawDevices, setSelection]);

  const onKeepCurrentDevice = useCallback(() => {
    if (!switchPrompt) return;
    savePromptedSignature(switchPrompt.signature);
    setSwitchPrompt(null);
  }, [switchPrompt]);

  const devices = toOutputDeviceOptions(rawDevices);
  const selectedDeviceMissing = hasEnumerated && isSelectedDeviceMissing(selection, rawDevices);

  return {
    devices,
    selection,
    setSelection,
    selectedDeviceMissing,
    selectedDeviceLabel: selection.mode === "explicit" ? selection.label : null,
    defaultDeviceChangedNotice: defaultChangedNotice,
    dismissDefaultDeviceChangedNotice,
    switchPrompt: switchPrompt ? { toLabel: switchPrompt.toLabel } : null,
    onSwitchToNewDefault,
    onKeepCurrentDevice,
  };
}
