import { SoundBindingRow } from "./SoundBindingRow";
import { SoundModal } from "./SoundModal";
import type { GameSoundEventKind, GameSoundSettings, TrackedItem } from "../../services/dotaCompanionApi";

interface Props {
  item: TrackedItem;
  settings: GameSoundSettings;
  onClose: () => void;
  onChooseFile: (eventId: string, kind: GameSoundEventKind) => Promise<void>;
  onPreview: (assetId: string) => Promise<void>;
  onRemove: (eventId: string) => Promise<void>;
}

// задача п.2's worked example ("Blood Grenade / Event: использование
// предмета / Sound: [не выбран] / [Выбрать файл] [Прослушать] [Удалить
// звук]") - Blood Grenade itself isn't in the catalog (see catalog.rs's
// module doc comment / the WK-106 report), but every catalog item that
// reaches this modal is guaranteed supported=true (ItemsGrid only opens it
// for supported tiles).
export function ItemSoundModal({ item, settings, onClose, onChooseFile, onPreview, onRemove }: Props) {
  const binding = settings.bindings.find((b) => b.eventId === item.id && b.kind === "itemUsed");
  return (
    <SoundModal title={item.displayName} onClose={onClose}>
      <div className="sound-modal__item">
        <img className="sound-modal__icon" src={item.iconUrl} alt="" width={48} height={36} />
        <dl className="sound-modal__meta">
          <dt>Событие</dt>
          <dd>Использование предмета</dd>
        </dl>
      </div>
      <SoundBindingRow
        eventId={item.id}
        kind="itemUsed"
        masterVolume={settings.masterVolume}
        binding={binding}
        assets={settings.assets}
        onChooseFile={onChooseFile}
        onPreview={onPreview}
        onRemove={onRemove}
      />
    </SoundModal>
  );
}
