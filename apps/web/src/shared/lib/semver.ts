const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Stable X.Y.Z only - prerelease/channel versions are never shown as published. */
export const isStableVersion = (value: unknown): value is string => typeof value === "string" && STABLE_VERSION.test(value);

export const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};
