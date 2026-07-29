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
        },
    },
});
