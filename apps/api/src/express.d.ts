declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      streamUserId?: string;
      // WK-116 Phase 4 - set by authenticate-twitch-extension.ts after
      // verifying the Extension's HS256 JWT. `userId` is only present when
      // the viewer shared identity with the Extension (Twitch's own
      // "share your identity" prompt) - `opaqueUserId` is always present
      // and is what scoring keys on when `userId` is absent, same as
      // Twitch's own documented viewer-identity contract.
      twitchExtension?: {
        channelId: string;
        opaqueUserId: string;
        userId: string | null;
        role: "viewer" | "broadcaster" | "moderator" | "external";
      };
    }
  }
}

export {};
