import type { Clock } from "../../ports/index.js";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
