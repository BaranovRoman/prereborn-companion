import type { ReactNode } from "react";
import { useModalBehavior } from "../../hooks/useModalBehavior";

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
// WK-115 - ESC-to-close/focus management factored out into useModalBehavior,
// the same shared hook SettingsModal uses, so both modal shells in the app
// behave identically instead of each keeping its own copy of this logic.
export function SoundModal({ title, onClose, children, wide }: Props) {
  const containerRef = useModalBehavior(true, onClose);

  return (
    <div className="sound-modal__backdrop" onClick={onClose}>
      <div
        ref={containerRef as React.RefObject<HTMLDivElement>}
        className={`sound-modal${wide ? " sound-modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
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
