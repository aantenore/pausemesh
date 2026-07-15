import { z } from "zod";

export const PauseMeshConfigSchema = z
  .object({
    databasePath: z.string().trim().min(1).default("./data/pausemesh.db"),
    host: z.string().trim().min(1).default("127.0.0.1"),
    logLevel: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    maxPayloadBytes: z.number().int().min(1_024).max(10_485_760).default(65_536),
    port: z.number().int().min(1).max(65_535).default(8_787),
    tokenTtlSeconds: z.number().int().min(30).max(604_800).default(900),
  })
  .strict();

export type PauseMeshConfig = z.infer<typeof PauseMeshConfigSchema>;
