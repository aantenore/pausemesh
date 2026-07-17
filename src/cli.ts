#!/usr/bin/env node

import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import pino from "pino";
import packageMetadata from "../package.json" with { type: "json" };
import { Sha256TokenIssuer } from "./adapters/crypto/sha256-token-issuer.js";
import { createHttpApp } from "./adapters/http/index.js";
import { SqliteEventStore } from "./adapters/storage/index.js";
import { SystemClock } from "./adapters/time/system-clock.js";
import { ContinuationService } from "./application/index.js";
import { loadConfig } from "./config/load.js";
import { PinoObserver } from "./observability/pino-observer.js";

const VERSION = packageMetadata.version;
const HELP = `PauseMesh ${VERSION}

Usage:
  pausemesh serve     Start the local reference HTTP server
  pausemesh --help    Show this help

Configuration is read from PAUSEMESH_* environment variables or the JSON file named by
PAUSEMESH_CONFIG_PATH. See .env.example. The reference server has no identity layer and must not
be exposed to an untrusted network.
`;

export function runCli(argv: string[] = process.argv.slice(2)): void {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    strict: true,
  });

  if (parsed.values.help === true) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const command = parsed.positionals[0] ?? "serve";
  if (command !== "serve" || parsed.positionals.length > 1) {
    throw new Error(`Unknown command: ${parsed.positionals.join(" ") || command}`);
  }

  const config = loadConfig();
  if (config.databasePath !== ":memory:") {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  }

  const logger = pino({
    level: config.logLevel,
    redact: {
      paths: ["req.headers.authorization", "resumeToken", "token", "payload", "resumePayload"],
      censor: "[REDACTED]",
    },
  });
  const eventStore = new SqliteEventStore(config.databasePath);
  const service = new ContinuationService({
    clock: new SystemClock(),
    eventStore,
    observer: new PinoObserver(logger),
    tokenIssuer: new Sha256TokenIssuer(),
    tokenTtlSeconds: config.tokenTtlSeconds,
  });
  const app = createHttpApp({ maxPayloadBytes: config.maxPayloadBytes, service });
  const server = serve(
    { fetch: app.fetch, hostname: config.host, port: config.port },
    ({ address, port }) => logger.info({ address, port }, "pausemesh.listening"),
  );

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "pausemesh.stopping");
    server.close((error) => {
      eventStore.close();
      if (error !== undefined) {
        logger.error({ error }, "pausemesh.shutdown_failed");
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

export function isDirectExecution(moduleUrl: string, entrypoint: string | undefined): boolean {
  if (entrypoint === undefined) return false;

  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entrypoint);
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  try {
    runCli();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    process.stderr.write(`PauseMesh failed to start: ${message}\n`);
    process.exitCode = 1;
  }
}
