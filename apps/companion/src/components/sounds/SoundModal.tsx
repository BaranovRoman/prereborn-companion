import { useEffect } from "react";
import type { ReactNode } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  // WK-108 - the horizontal hero-ability bar needs more width than the
  // original single-column item modal to avoid wrapping every hero down to
  // a cramped 1-2 cards per row at the 960x640 minimum window size.
  wide?: boolean;
}

// Small, dependency-free modal shell shared by ItemSoundModal/HeroAbilitiesModal -
// no existing generic Modal component in this codebase to reuse (checked).
export function SoundModal({ title, onClose, children, wide }: Props) {
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
        className={`sound-modal${wide ? " sound-modal--wide" : ""}`}
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
