import { useEffect } from "react";
import type { ReactNode } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

// Small, dependency-free modal shell shared by ItemSoundModal/HeroAbilitiesModal -
// no existing generic Modal component in this codebase to reuse (checked).
export function SoundModal({ title, onClose, children }: Props) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="sound-modal__backdrop" onClick={onClose}>
      <div
        className="sound-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sound-modal__header">
          <h3>{title}</h3>
          <button className="sound-modal__close" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        <div className="sound-modal__body">{children}</div>
      </div>
    </div>
  );
}
