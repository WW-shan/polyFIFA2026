import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { continuousConfig, loadContinuousConfig, type ContinuousConfig } from "../../src/collector/continuous-config.js";

// Keep config-file fixtures in memory so this slice writes only its four files.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: vi.fn()
}));

const project = resolve("/collector-fixtures/project");

beforeEach(() => vi.mocked(readFile).mockReset());
afterEach(() => vi.unstubAllEnvs());

describe("continuous configuration", () => {
  test("supplies the shared defaults without adopting an environment proxy", () => {
    vi.stubEnv("HTTPS_PROXY", "http://environment-proxy.example:8080");
    expect(continuousConfig({}, project)).toEqual({
      dataRoot: resolve(project, "data/collector/continuous"),
      profiles: [{ name: "tennis", tagId: "864" }, { name: "table-tennis", tagId: "103767" }],
      discoveryIntervalMs: 30_000,
      snapshotIntervalMs: 60_000,
      httpTimeoutMs: 10_000,
      postFinishRetentionMs: 600_000,
      pulseIntervalMs: 5_000,
      minFreeBytes: 20 * 1024 ** 3,
      port: 8765,
      lookbackHours: 6,
      aheadHours: 2,
      gammaBaseUrl: "https://gamma-api.polymarket.com",
      clobBaseUrl: "https://clob.polymarket.com",
      clobWsUrl: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      sportsWsUrl: "wss://sports-api.polymarket.com/ws",
      retryDelayMs: 5_000,
      exportTimeoutMs: 600_000,
      compressionEnabled: false,
      compressionIntervalMs: 60_000,
      compressionMaxSegments: 4,
      compressionTimeoutMs: 120_000,
      singleMatchOnly: true,
      compactStorageEnabled: false,
      tailWindowSeconds: 180,
      tailBufferSeconds: 30,
      tailRetentionDays: 30,
      maxTailStoreBytes: 8 * 1024 ** 3,
      maintenanceIntervalMs: 60_000
    } satisfies ContinuousConfig);
    expect(readFile).not.toHaveBeenCalled();
  });

  test("loads defaults without reading configuration or trading environment files", async () => {
    expect(await loadContinuousConfig(undefined, project)).toEqual(continuousConfig({}, project));
    expect(readFile).not.toHaveBeenCalled();
  });

  test("defaults to the working directory and returns independent profile objects", () => {
    const first = continuousConfig();
    first.profiles[0]!.name = "changed";
    first.profiles.push({ name: "extra", tagId: "extra" });
    const next = continuousConfig();
    expect(next.dataRoot).toBe(resolve(process.cwd(), "data/collector/continuous"));
    expect(next.profiles).toEqual([{ name: "tennis", tagId: "864" }, { name: "table-tennis", tagId: "103767" }]);
  });

  test("applies supplied settings and resolves a relative data root without mutating input", () => {
    const input: ContinuousConfig = {
      dataRoot: "captures/run",
      profiles: [{ name: " custom sport ", tagId: " custom-tag " }],
      discoveryIntervalMs: 1, snapshotIntervalMs: 2, httpTimeoutMs: 3,
      postFinishRetentionMs: 0, pulseIntervalMs: 4, minFreeBytes: 1, port: 1,
      lookbackHours: 0.25, aheadHours: 0, retryDelayMs: 5, exportTimeoutMs: 6,
      compressionEnabled: true, compressionIntervalMs: 7, compressionMaxSegments: 3, compressionTimeoutMs: 8,
      singleMatchOnly: false,
      compactStorageEnabled: true, tailWindowSeconds: 181, tailBufferSeconds: 31, tailRetentionDays: 7,
      maxTailStoreBytes: 123456, maintenanceIntervalMs: 8,
      proxyUrl: "http://proxy-user:proxy-secret@127.0.0.1:8080",
      gammaBaseUrl: "http://gamma.fixture.test/api/",
      clobBaseUrl: "https://clob.fixture.test/api",
      clobWsUrl: "ws://clob.fixture.test/market",
      sportsWsUrl: "wss://sports.fixture.test/ws"
    };
    Object.freeze(input.profiles[0]);
    Object.freeze(input.profiles);
    Object.freeze(input);

    const result = continuousConfig(input, project);

    expect(result).toEqual({
      ...input, dataRoot: resolve(project, "captures/run"),
      profiles: [{ name: "custom sport", tagId: "custom-tag" }]
    });
    expect(result.profiles).not.toBe(input.profiles);
    expect(result.profiles[0]).not.toBe(input.profiles[0]);
  });

  test("ignores undefined overrides", () => {
    expect(continuousConfig({ port: undefined, profiles: undefined } as unknown as Partial<ContinuousConfig>, project))
      .toEqual(continuousConfig({}, project));
  });

  test.each([
    "discoveryIntervalMs", "snapshotIntervalMs", "httpTimeoutMs", "pulseIntervalMs",
    "retryDelayMs", "exportTimeoutMs", "minFreeBytes"
  ] as const)("requires a positive safe integer for %s", (field) => {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, true]) {
      expect(() => continuousConfig({ [field]: value } as Partial<ContinuousConfig>, project)).toThrow(field);
    }
    expect(continuousConfig({ [field]: 1 }, project)[field]).toBe(1);
  });

  test.each(["tailWindowSeconds", "tailBufferSeconds", "maxTailStoreBytes", "maintenanceIntervalMs"] as const)("requires a positive compact-storage value for %s", field => {
    for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, true]) {
      expect(() => continuousConfig({ [field]: value } as Partial<ContinuousConfig>, project)).toThrow(field);
    }
  });

  test("validates compact storage flags and retention days", () => {
    expect(continuousConfig({ compactStorageEnabled: true, tailRetentionDays: 0 }, project)).toMatchObject({ compactStorageEnabled: true, tailRetentionDays: 0 });
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "0"]) {
      expect(() => continuousConfig({ tailRetentionDays: value } as Partial<ContinuousConfig>, project)).toThrow("tailRetentionDays");
    }
    for (const value of [0, 1, "true", null]) {
      expect(() => continuousConfig({ compactStorageEnabled: value } as unknown as Partial<ContinuousConfig>, project)).toThrow("compactStorageEnabled");
    }
  });

  test("allows zero retention and rejects invalid retention durations", () => {
    expect(continuousConfig({ postFinishRetentionMs: 0 }, project).postFinishRetentionMs).toBe(0);
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, "0"]) {
      expect(() => continuousConfig({ postFinishRetentionMs: value } as Partial<ContinuousConfig>, project))
        .toThrow("postFinishRetentionMs");
    }
  });

  test("restricts the port to the inclusive integer range 1 through 65535", () => {
    for (const port of [0, -1, 65_536, 1.5, NaN, Infinity, "8765", null]) {
      expect(() => continuousConfig({ port } as Partial<ContinuousConfig>, project)).toThrow("port");
    }
    expect(continuousConfig({ port: 65_535 }, project).port).toBe(65_535);
  });

  test.each(["lookbackHours", "aheadHours"] as const)("allows finite nonnegative %s including fractions", (field) => {
    for (const value of [-1, NaN, Infinity, -Infinity, null, "0", false]) {
      expect(() => continuousConfig({ [field]: value } as Partial<ContinuousConfig>, project)).toThrow(field);
    }
    for (const value of [0, 0.5]) expect(continuousConfig({ [field]: value }, project)[field]).toBe(value);
  });

  test.each([
    [], null, "tennis", {}, [null], [{}], [{ name: "", tagId: "864" }],
    [{ name: "tennis", tagId: " " }], [{ name: 1, tagId: "864" }], [{ name: "tennis", tagId: 864 }],
    [{ name: "tennis", tagId: "864" }, { name: " tennis ", tagId: "123" }],
    [{ name: "tennis", tagId: "864" }, { name: "other", tagId: " 864 " }]
  ].map((value) => ({ value })))("rejects empty, malformed, or duplicate profiles: $value", ({ value }) => {
    expect(() => continuousConfig({ profiles: value } as Partial<ContinuousConfig>, project)).toThrow("profiles");
  });

  test("rejects missing entries in a sparse profiles array", () => {
    const profiles = new Array<ContinuousConfig["profiles"][number]>(1);
    expect(() => continuousConfig({ profiles }, project)).toThrow("profiles");
  });

  test.each(["gammaBaseUrl", "clobBaseUrl"] as const)("requires an HTTP(S) %s", (field) => {
    for (const value of [null, 1, "", "/relative", "ftp://host", "ws://host", "http://user:proxy-secret@"])
      expect(() => continuousConfig({ [field]: value } as Partial<ContinuousConfig>, project)).toThrow(field);
  });

  test.each(["clobWsUrl", "sportsWsUrl"] as const)("requires a WS(S) %s", (field) => {
    for (const value of [null, 1, "", "/relative", "http://host", "https://host", "wss://user:proxy-secret@"])
      expect(() => continuousConfig({ [field]: value } as Partial<ContinuousConfig>, project)).toThrow(field);
  });

  test("uses the existing proxy validator without including credentials in errors", () => {
    for (const proxyUrl of [
      "socks5://proxy-user:proxy-secret@localhost:1080", "not-a-url-proxy-secret",
      "proxy-secret://localhost", "http://proxy-user:proxy-secret@", null, 1
    ]) {
      let failure: unknown;
      try { continuousConfig({ proxyUrl } as Partial<ContinuousConfig>, project); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("proxyUrl");
      expect((failure as Error).message).not.toContain("proxy-secret");
      expect((failure as Error).message).not.toContain("proxy-user");
    }
    for (const proxyUrl of ["", "http://localhost:8080", "https://proxy-user:proxy-secret@localhost:8080"]) {
      expect(continuousConfig({ proxyUrl }, project).proxyUrl).toBe(proxyUrl);
    }
  });

  test.each(["", "  ", "/", "/nested/..", project, ".", "nested/..", "bad\0path", null, 123])(
    "rejects an invalid or broad data root: %j", (dataRoot) => {
      expect(() => continuousConfig({ dataRoot } as Partial<ContinuousConfig>, project)).toThrow("dataRoot");
    }
  );

  test.each([null, [], "config", 123, true].map((input) => ({ input })))("rejects a non-object configuration: $input", ({ input }) => {
    expect(() => continuousConfig(input as Partial<ContinuousConfig>, project)).toThrow("CONTINUOUS_CONFIG_INVALID");
  });
});

describe("continuous configuration file loading", () => {
  test.each([
    { path: "settings/continuous.json", dataRoot: "../captures", expected: resolve(project, "captures") },
    { path: "settings/continuous.json", dataRoot: ".", expected: resolve(project, "settings") },
    { path: "/collector-configs/continuous.json", dataRoot: "captures", expected: "/collector-configs/captures" },
    { path: "settings/continuous.json", dataRoot: "/collector-data/captures", expected: "/collector-data/captures" }
  ])("resolves dataRoot against the selected file: $path / $dataRoot", async ({ path, dataRoot, expected }) => {
    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ dataRoot, port: 9000 }));
    const config = await loadContinuousConfig(path, project);
    expect(config.dataRoot).toBe(expected);
    expect(config.port).toBe(9000);
    expect(readFile).toHaveBeenCalledExactlyOnceWith(resolve(project, path), "utf8");
  });

  test("keeps the default data root relative to the project when the file omits it", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("{}");
    expect(await loadContinuousConfig("settings/continuous.json", project)).toEqual(continuousConfig({}, project));
  });

  test("reports malformed JSON with its file path without quoting secret content", async () => {
    vi.mocked(readFile).mockResolvedValueOnce('{"proxyUrl":"http://proxy-user:proxy-secret@localhost:8080",');
    const result = loadContinuousConfig("settings/continuous.json", project);
    await expect(result).rejects.toThrow(/JSON/);
    await expect(result).rejects.toThrow(resolve(project, "settings/continuous.json"));
    await expect(result).rejects.not.toThrow("proxy-secret");
    await expect(result).rejects.not.toThrow("proxy-user");
  });

  test("rejects an explicitly missing configuration file with context", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error("missing fixture"), { code: "ENOENT" }));
    const result = loadContinuousConfig("missing.json", project);
    await expect(result).rejects.toThrow(resolve(project, "missing.json"));
    await expect(result).rejects.toThrow("ENOENT");
  });

  test.each([null, [], false, "config", 123, { port: "8765" }, { dataRoot: "" }, { dataRoot: "/" }, { dataRoot: ".." }].map((input) => ({ input })))(
    "validates parsed configuration values: $input", async ({ input }) => {
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(input));
      await expect(loadContinuousConfig("settings/continuous.json", project)).rejects.toThrow("CONTINUOUS_CONFIG_INVALID");
    }
  );

  test("rejects a blank explicit path without falling back to defaults", async () => {
    await expect(loadContinuousConfig("  ", project)).rejects.toThrow("path");
    expect(readFile).not.toHaveBeenCalled();
  });
});
