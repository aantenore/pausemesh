import {
  ContinuationService,
  fromAguiRunAgentInput,
  InMemoryEventStore,
  issueAguiInterrupts,
  issueMcpElicitation,
  type JsonValue,
  NoopObserver,
  Sha256TokenIssuer,
  toA2AInterruptedTask,
  toAguiResumeEntry,
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

const aguiIssuance = issueAguiInterrupts([created.continuation], {
  threadId: "demo-thread",
  runId: "demo-agui-run",
});
const mcpIssuance = issueMcpElicitation(created.continuation, {
  requestId: "demo-mcp-request",
  clientCapabilities: { elicitation: { form: {} } },
});
const projections = {
  mcp: {
    request: mcpIssuance.request,
    receiptPersisted: true,
    receiptSchemaVersion: mcpIssuance.receipt.schemaVersion,
  },
  a2a: toA2AInterruptedTask(created.continuation, {
    contextId: "demo-thread",
    taskId: "demo-a2a-server-task",
  }),
  agui: {
    event: aguiIssuance.event,
    receiptPersisted: true,
    receiptSchemaVersion: aguiIssuance.receipt.schemaVersion,
  },
};

const aguiValidation = fromAguiRunAgentInput(
  {
    threadId: "demo-thread",
    runId: "demo-agui-resume-run",
    state: {},
    messages: [],
    tools: [],
    context: [],
    forwardedProps: {},
    resume: [
      toAguiResumeEntry(created.continuation.continuationId, {
        status: "resolved",
        payload: { region: "eu", source: "ag-ui" },
      }),
    ],
  },
  aguiIssuance.receipt,
  [created.continuation],
  {
    now: new Date("2026-07-15T08:01:00.000Z"),
    validatePayload: ({ payload }) => {
      const candidate = payload as { readonly region?: JsonValue };
      return {
        valid:
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          (candidate.region === "eu" || candidate.region === "us"),
      };
    },
  },
);
if (!aguiValidation.ok || aguiValidation.commands[0]?.action !== "resume") {
  throw new Error("AG-UI demo resume did not validate");
}
const resumeCommand = aguiValidation.commands[0];
const resumed = await service.resume({
  continuationId: resumeCommand.continuationId,
  idempotencyKey: resumeCommand.idempotencyKey,
  resumePayload: resumeCommand.resumePayload,
  resumeToken: created.resumeToken,
});

process.stdout.write(`${JSON.stringify({ projections, resumed }, null, 2)}\n`);
