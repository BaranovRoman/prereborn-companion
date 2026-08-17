import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        globals: true,
        fileParallelism: false,
        testTimeout: 15000,
        env: {
            NODE_ENV: "test",
            STREAM_JWT_SECRET: "test-only-stream-jwt-secret-not-for-production",
            ADMIN_EMAILS: "admin_wk52_test@example.com",
            TWITCH_CLIENT_ID: "test-twitch-client-id",
            TWITCH_CLIENT_SECRET: "test-twitch-client-secret",
            TWITCH_REDIRECT_URI: "http://localhost/api/stream/twitch/callback",
            TWITCH_FRONTEND_ORIGIN: "http://localhost:3000",
        },
    },
});
