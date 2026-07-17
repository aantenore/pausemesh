export type ProtocolAdapterErrorCode =
  | "INVALID_PROTOCOL_BINDING"
  | "INVALID_PROTOCOL_MESSAGE"
  | "INVALID_PROTOCOL_TRANSITION"
  | "UNSUPPORTED_PROTOCOL_CAPABILITY";

export class ProtocolAdapterError extends Error {
  constructor(
    readonly code: ProtocolAdapterErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolAdapterError";
  }
}
