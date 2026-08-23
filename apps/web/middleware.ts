import { NextResponse } from "next/server";

// WK-88 follow-up (production regression) - stamps the root response with
// the release this process was actually started from (PREREBORN_RELEASE_SHA,
// set by release.sh via ecosystem.config.cjs's PM2 env), so the deploy
// pipeline's health check can prove the *running* web process matches the
// release `current` was just switched to - not just that "something"
// answers on the port. This is exactly the gap that let a stale PM2 process
// keep serving an old release undetected (see release.sh's health_check()).
// Scoped to `/` only: that's the one path release.sh already HEAD-requests,
// and it keeps this middleware from touching any other route.
export function middleware() {
  const response = NextResponse.next();
  response.headers.set(
    "X-Release-Sha",
    process.env.PREREBORN_RELEASE_SHA || "unknown"
  );
  return response;
}

export const config = {
  matcher: "/"
};
