import { useState } from "react";
import type { GameSoundEventKind, ManagedSoundAsset, SoundBinding } from "../../services/dotaCompanionApi";

interface Props {
  eventId: string;
  kind: GameSoundEventKind;
  masterVolume: number;
  binding: SoundBinding | undefined;
  assets: ManagedSoundAsset[];
  onChooseFile: (eventId: string, kind: GameSoundEventKind) => Promise<void>;
  onPreview: (assetId: string) => Promise<void>;
  onRemove: (eventId: string) => Promise<void>;
}

// One event's sound controls - "Выбрать файл / Прослушать / Удалить звук"
// (задача п.2's Blood Grenade example) - shared between ItemSoundModal (one
// row) and HeroAbilitiesModal (one row per ability).
export function SoundBindingRow({ eventId, kind, binding, assets, onChooseFile, onPreview, onRemove }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asset = binding ? assets.find((a) => a.id === binding.assetId) : undefined;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sound-binding-row">
      <span className="sound-binding-row__file">
        {asset ? asset.originalName : "Звук не выбран"}
      </span>
      <div className="sound-binding-row__actions">
        <button disabled={busy} onClick={() => void run(() => onChooseFile(eventId, kind))}>
          Выбрать файл
        </button>
        <button disabled={busy || !asset} onClick={() => void run(() => onPreview(asset!.id))}>
          Прослушать
        </button>
        <button disabled={busy || !asset} onClick={() => void run(() => onRemove(eventId))}>
          Удалить звук
        </button>
      </div>
      {error && <p className="sound-binding-row__error">Ошибка: {error}</p>}
    </div>
  );
}
