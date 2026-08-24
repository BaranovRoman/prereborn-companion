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
//
// WK-96 - X-Release-Build-Id is the sibling identity header: two artifacts
// can share the same commit SHA (build-time-only inputs like the resolved
// Companion download version/URL aren't part of the git tree - see
// release.sh's header comment for the full root cause), so SHA alone can no
// longer prove the *specific* artifact currently running.
export function middleware() {
  const response = NextResponse.next();
  response.headers.set(
    "X-Release-Sha",
    process.env.PREREBORN_RELEASE_SHA || "unknown"
  );
  response.headers.set(
    "X-Release-Build-Id",
    process.env.PREREBORN_RELEASE_BUILD_ID || "unknown"
  );
  return response;
}

export const config = {
  matcher: "/"
};
