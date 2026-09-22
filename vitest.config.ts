import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    // Real-work integration/stress suites run full CLI passes and file I/O; the
    // slowest single case measures ~6s under full parallel load, so the Vitest
    // 5s default produced flaky timeouts. Keep explicit headroom.
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
});
