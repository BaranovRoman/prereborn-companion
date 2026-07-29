"use client";

import { useCallback } from "react";

export function usePageReady(_minDurationMs = 0) {
  const ready = useCallback(() => undefined, []);
  return { ready };
}

