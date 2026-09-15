import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { loadContinuousConfig } from "../../src/collector/continuous-config.js";

test("the deployed profile captures single matches with catch-up compression and the disk reserve intact", async () => {
  const path = fileURLToPath(new URL("../../collector.config.json", import.meta.url));
  const config = await loadContinuousConfig(path);
  expect(config).toMatchObject({
    singleMatchOnly: true,
    compressionEnabled: true,
    compressionMaxSegments: 64,
    compressionIntervalMs: 60_000,
    compressionTimeoutMs: 120_000,
    minFreeBytes: 20 * 1024 ** 3
  });
});
