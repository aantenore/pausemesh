import {
  ContinuationService,
  InMemoryEventStore,
  NoopObserver,
  Sha256TokenIssuer,
  toA2AInterruptedTask,
  toAguiInterruptEvent,
  toMcpElicitRequest,
} from "../src/index.js";

const service = new ContinuationService({
  clock: { now: () => new Date("2026-07-15T08:00:00.000Z") },
  eventStore: new InMemoryEventStore(),
  generateId: () => "demo-generated-id",
  observer: new NoopObserver(),
  tokenIssuer: new Sha256TokenIssuer(),
  tokenTtlSeconds: 900,
});

const created = await service.create({
  continuationId: "demo-continuation",
  correlationId: "demo-thread",
  metadata: { a2aTaskId: "demo-a2a-task", aguiRunId: "demo-agui-run" },
  payload: {
    kind: "input",
    message: "Choose the data residency region",
    responseSchema: {
      type: "object",
      properties: { region: { type: "string", enum: ["eu", "us"] } },
      required: ["region"],
    },
  },
});

const projections = {
  mcp: toMcpElicitRequest(created.continuation),
  a2a: toA2AInterruptedTask(created.continuation),
  agui: toAguiInterruptEvent(created.continuation),
};

const resumed = await service.resume({
  continuationId: created.continuation.continuationId,
  idempotencyKey: "demo-response-1",
  resumePayload: { region: "eu", source: "ag-ui" },
  resumeToken: created.resumeToken,
});

process.stdout.write(`${JSON.stringify({ projections, resumed }, null, 2)}\n`);
