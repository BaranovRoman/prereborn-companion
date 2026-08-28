import { useEffect, useRef } from "react";

// WK-115 - consistency primitive: both modal shells in this app (SoundModal,
// SettingsModal) had their own copy of "Escape closes the modal" - this is
// the one shared place for that, plus focus management neither modal had
// before: focus moves into the modal when it opens (so keyboard users don't
// have to Tab in from wherever the trigger happened to be) and returns to
// whatever triggered it when it closes (so closing a modal never strands
// keyboard focus on a removed element).
export function useModalBehavior(active: boolean, onClose: () => void) {
  const containerRef = useRef<HTMLElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    containerRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [active, onClose]);

  return containerRef;
}
