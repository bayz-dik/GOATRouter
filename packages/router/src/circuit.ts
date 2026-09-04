/**
 * Lightweight in-memory circuit breaker for per-provider transient-failure
 * protection.
 *
 * All state is held in memory and never persisted (no SQLite write on any
 * path). Cooldown is evaluated lazily when a request arrives: there are no
 * timers, no polling loop, and no background worker.
 *
 * States:
 *   closed    — normal; calls allowed. Transient failures accumulate a streak.
 *               At `threshold` failures the circuit transitions to `open`.
 *   open      — routing to this provider is refused. After `cooldownMs` the
 *               next call is admitted as a single half-open probe.
 *   half_open — exactly one probe is allowed. Probe success -> closed and the
 *               streak resets; probe failure -> open again (fresh cooldown).
 *
 * A successful call at any time resets the transient-failure streak (`closed`)
 * or returns the circuit to `closed` (`half_open`). Non-transient failures are
 * never reported here, so they neither open nor reset a circuit.
 *
 * Time is injected (`now`) so cooldown behaviour can be tested with elapsed
 * ticks instead of real 30-second sleeps.
 */
export type CircuitState = "closed" | "open" | "half_open";

export type CircuitOptions = {
  /**
   * Transient failures in a row that open the circuit. Default 3.
   */
  threshold?: number;
  /**
   * Milliseconds the circuit stays `open` before the next call is admitted as
   * a half-open probe. Default 30_000.
   */
  cooldownMs?: number;
  /**
   * A monotonic-ish clock in milliseconds. Injected for tests; defaults to
   * `Date.now`. The return value only ever needs to be comparable.
   */
  now?: () => number;
};

type CircuitStatePrivate =
  | { state: "closed"; streak: number }
  | { state: "open"; openedAt: number }
  | { state: "half_open"; probeUsed: boolean };

const CLOSED: CircuitStatePrivate = { state: "closed", streak: 0 };

export class CircuitBreaker {
  readonly threshold: number;
  readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly byProvider = new Map<string, CircuitStatePrivate>();

  constructor(options: CircuitOptions = {}) {
    this.threshold = options.threshold ?? 3;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** The stable state label for a provider (for diagnostics/tests). */
  state(providerId: string): CircuitState {
    const entry = this.byProvider.get(providerId);
    if (entry === undefined) {
      return "closed";
    }
    return entry.state;
  }

  /**
   * Whether routing to this provider is currently permitted.
   *
   * Pure read with a lazy side effect: an `open` circuit past its cooldown
   * transitions to `half_open` and admits the one probe. All synchronous, so
   * two interleaved callers cannot both be admitted: the transition consumes
   * the probe in the same turn. Keeps cooldown evaluation on the request path
   * with no timer.
   */
  allow(providerId: string): boolean {
    const entry = this.byProvider.get(providerId);
    if (entry === undefined) {
      this.byProvider.set(providerId, { ...CLOSED });
      return true;
    }
    if (entry.state === "closed") {
      return true;
    }
    if (entry.state === "half_open") {
      if (entry.probeUsed) {
        return false;
      }
      entry.probeUsed = true;
      return true;
    }
    // open
    const elapsed = this.now() - entry.openedAt;
    if (elapsed >= this.cooldownMs) {
      // Admit exactly one probe. It is consumed immediately so a second call
      // in the same cooldown expiry is refused.
      this.byProvider.set(providerId, {
        state: "half_open",
        probeUsed: true,
      });
      return true;
    }
    return false;
  }

  /** Report a successful upstream call for a provider. */
  onSuccess(providerId: string): void {
    const entry = this.byProvider.get(providerId);
    if (entry === undefined) {
      this.byProvider.set(providerId, { ...CLOSED });
      return;
    }
    if (entry.state === "half_open") {
      // The probe succeeded: close and reset.
      this.byProvider.set(providerId, { ...CLOSED });
      return;
    }
    // closed (or open reached a success — treat as recovery, close).
    this.byProvider.set(providerId, { ...CLOSED });
  }

  /**
   * Report a transient upstream failure for a provider.
   *
   * Only transient failures (unreachable, rate_limited, upstream_error) should
   * ever reach here. A non-transient failure must not open a circuit, because
   * that would mask a config error behind "another provider succeeded".
   */
  onTransientFailure(providerId: string): void {
    const entry = this.byProvider.get(providerId);
    if (entry !== undefined && entry.state === "half_open") {
      // The probe failed: re-open with a fresh cooldown.
      this.byProvider.set(providerId, {
        state: "open",
        openedAt: this.now(),
      });
      return;
    }
    if (entry !== undefined && entry.state === "open") {
      // Keep open, restart cooldown so a sustained outage does not hot-loop.
      this.byProvider.set(providerId, {
        state: "open",
        openedAt: this.now(),
      });
      return;
    }
    // closed (first failure initializes the streak at 0 then counts up), so the
    // threshold check below applies uniformly.
    const streak = (entry === undefined ? 0 : entry.streak) + 1;
    if (streak >= this.threshold) {
      this.byProvider.set(providerId, {
        state: "open",
        openedAt: this.now(),
      });
      return;
    }
    this.byProvider.set(providerId, { state: "closed", streak });
  }
}
