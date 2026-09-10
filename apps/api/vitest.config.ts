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
            // Base64 of a 32-byte test-only key - matches the shape a real
            // Twitch Extension secret has, not a real credential.
            TWITCH_EXTENSION_SECRET: "dGVzdC1vbmx5LXR3aXRjaC1leHRlbnNpb24tc2VjcmV0LTMyYg==",
        },
    },
});
