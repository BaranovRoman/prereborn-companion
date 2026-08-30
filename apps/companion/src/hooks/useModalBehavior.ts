import { useEffect, useRef } from "react";

// WK-115 - consistency primitive: both modal shells in this app (SoundModal,
// SettingsModal) had their own copy of "Escape closes the modal" - this is
// the one shared place for that, plus focus management neither modal had
// before: focus moves into the modal when it opens (so keyboard users don't
// have to Tab in from wherever the trigger happened to be) and returns to
// whatever triggered it when it closes (so closing a modal never strands
// keyboard focus on a removed element).
//
// WK-128 P0 FIX - production bug: typing into any input inside SettingsModal
// (e.g. AccountForm's login email/password) repeatedly lost focus mid-word.
// Root cause: this effect used to list `onClose` in its dependency array,
// and AppShell passes an inline `onClose={() => setSettingsOpen(false)}` -
// a NEW function identity on every AppShell render. AppShell re-renders
// continuously from its own status/GSI polling hooks, unrelated to whether
// the modal is even open, so `onClose`'s identity kept "changing" on
// essentially every tick - re-running this effect, which called
// `containerRef.current?.focus()` every single time, yanking focus off
// whatever input the user was actively typing into and onto the modal's own
// container div. `onCloseRef` decouples "the latest onClose to call on
// Escape" (updated every render, cheap, triggers nothing) from "when to
// actually steal focus" (now correctly only `[active]` - the modal's own
// open/closed transition, never a caller's callback identity). This fixes
// the bug for EVERY caller of this hook, not just by asking AppShell to
// memoize its callback (which stays good practice but is no longer
// load-bearing for correctness here).
export function useModalBehavior(active: boolean, onClose: () => void) {
  const containerRef = useRef<HTMLElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    containerRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return containerRef;
}
