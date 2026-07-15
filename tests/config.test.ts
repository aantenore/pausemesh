import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";

describe("loadConfig", () => {
  it("loads safe local defaults", () => {
    expect(loadConfig({ env: {} })).toEqual({
      databasePath: "./data/pausemesh.db",
      host: "127.0.0.1",
      logLevel: "info",
      maxPayloadBytes: 65_536,
      port: 8_787,
      tokenTtlSeconds: 900,
    });
  });

  it("merges a JSON file with environment overrides", () => {
    const config = loadConfig({
      env: {
        PAUSEMESH_CONFIG_PATH: "/config.json",
        PAUSEMESH_PORT: "9000",
      },
      readTextFile: () => JSON.stringify({ host: "0.0.0.0", port: 8_000 }),
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9_000);
  });

  it("fails fast for invalid integer input", () => {
    expect(() => loadConfig({ env: { PAUSEMESH_PORT: "8.7" } })).toThrow(
      "PAUSEMESH_PORT must be an integer",
    );
  });

  it("rejects unknown configuration keys", () => {
    expect(() =>
      loadConfig({
        env: { PAUSEMESH_CONFIG_PATH: "/config.json" },
        readTextFile: () => JSON.stringify({ planner: { enabled: true } }),
      }),
    ).toThrow();
  });
});
