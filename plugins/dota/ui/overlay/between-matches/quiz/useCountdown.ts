import { useEffect, useState } from "react";

// WK-116 - ticks a local countdown to `phaseEndsAt` independently of how
// often new quiz state actually arrives (poll cadence). `phaseEndsAt` is an
// absolute timestamp precisely so the visible timer can be smooth locally
// via plain Date.now() diffs, per the plan's Phase 1 transport decision -
// the backend never needs to push every second for the countdown to look
// right.
//
// Deliberately ticks a single `now` clock (started once, never restarted)
// rather than resetting a `secondsLeft` state whenever `phaseEndsAt`
// changes - `secondsLeft` itself is a pure derived value computed at render
// time from `now` + the latest `phaseEndsAt`, so a phase transition just
// changes what that render computes, with no synchronous setState-in-effect
// (which react-hooks/set-state-in-effect correctly flags as cascading-
// render-prone) ever needed.
export function useCountdown(phaseEndsAt: string): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const interval = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(interval);
    }, []);

    return Math.max(0, Math.ceil((new Date(phaseEndsAt).getTime() - now) / 1000));
}
