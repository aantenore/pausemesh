import { readFileSync } from "node:fs";
import { type PauseMeshConfig, PauseMeshConfigSchema } from "./schema.js";

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  readTextFile?: (path: string) => string;
}

function optionalInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^-?\d+$/.test(value.trim())) {
    throw new Error(`${name} must be an integer`);
  }

  return Number(value);
}

function readJsonConfig(
  path: string | undefined,
  readTextFile: (path: string) => string,
): Record<string, unknown> {
  if (path === undefined) {
    return {};
  }

  const parsed: unknown = JSON.parse(readTextFile(path));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PAUSEMESH_CONFIG_PATH must point to a JSON object");
  }

  return parsed as Record<string, unknown>;
}

export function loadConfig(options: LoadConfigOptions = {}): PauseMeshConfig {
  const env = options.env ?? process.env;
  const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const fileConfig = readJsonConfig(env.PAUSEMESH_CONFIG_PATH, readTextFile);

  const environmentConfig = {
    databasePath: env.PAUSEMESH_DATABASE_PATH,
    host: env.PAUSEMESH_HOST,
    logLevel: env.PAUSEMESH_LOG_LEVEL,
    maxPayloadBytes: optionalInteger(
      env.PAUSEMESH_MAX_PAYLOAD_BYTES,
      "PAUSEMESH_MAX_PAYLOAD_BYTES",
    ),
    port: optionalInteger(env.PAUSEMESH_PORT, "PAUSEMESH_PORT"),
    tokenTtlSeconds: optionalInteger(
      env.PAUSEMESH_TOKEN_TTL_SECONDS,
      "PAUSEMESH_TOKEN_TTL_SECONDS",
    ),
  };

  return PauseMeshConfigSchema.parse({
    ...fileConfig,
    ...Object.fromEntries(
      Object.entries(environmentConfig).filter(([, value]) => value !== undefined),
    ),
  });
}
