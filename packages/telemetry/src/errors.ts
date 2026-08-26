export type TelemetryErrorCode = "invalid_event" | "storage_failed";

/**
 * Fixed, caller-independent messages.
 *
 * Telemetry sits next to prompts, completions, and credentials, so an error here
 * must not be able to carry any of them. No underlying message is ever
 * interpolated, and the original throw is discarded rather than attached as
 * `cause` — several structured loggers serialize `cause`.
 */
const MESSAGES: Record<TelemetryErrorCode, string> = {
  invalid_event: "invalid_event: the telemetry event was rejected",
  storage_failed: "storage_failed: the usage record could not be written",
};

export class TelemetryError extends Error {
  readonly code: TelemetryErrorCode;
  readonly stage: string | undefined;

  constructor(code: TelemetryErrorCode, stage?: string) {
    super(stage ? `${MESSAGES[code]} (stage: ${stage})` : MESSAGES[code]);
    this.name = "TelemetryError";
    this.code = code;
    this.stage = stage;
  }
}
