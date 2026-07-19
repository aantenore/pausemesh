/**
 * A dependency readiness check owned by the application composition root.
 *
 * Implementations either resolve or throw. HTTP adapters deliberately project
 * only the bounded ready/unavailable state and never expose the thrown error.
 */
export interface ReadinessProbe {
  checkReadiness(): Promise<void>;
}
