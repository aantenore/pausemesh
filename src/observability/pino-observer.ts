import type { Logger } from "pino";
import type { ContinuationObservation, Observer } from "../ports/index.js";

export class PinoObserver implements Observer {
  constructor(private readonly logger: Logger) {}

  observe(event: ContinuationObservation): void {
    this.logger.info({ pausemesh: event }, event.name);
  }
}

export class NoopObserver implements Observer {
  observe(_event: ContinuationObservation): void {}
}
