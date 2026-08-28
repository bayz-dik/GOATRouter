import { ProviderError } from "@bayz/providers";
import { RouterError } from "./errors.js";

/**
 * How many upstream requests may be in flight at once, by default.
 *
 * 32 is chosen against what the resource actually is: each in-flight request holds a
 * socket, a file descriptor, up to `MAX_RESPONSE_BYTES` of buffer, and an upstream
 * generating tokens. On the ARM64 device this is developed on, 32 concurrent TLS
 * connections is comfortable while 500 is not.
 */
export const OUTBOUND_CONCURRENCY_DEFAULT = 32;
export const OUTBOUND_CONCURRENCY_MIN = 1;
export const OUTBOUND_CONCURRENCY_MAX = 512;

/**
 * How many callers may *wait* before one is refused.
 *
 * Bounded for the same reason the cap exists. An unbounded queue converts a slow
 * upstream into unbounded memory and unbounded latency: every caller waits, none is
 * told, and the process eventually dies holding requests nobody is still waiting for.
 * Refusing the 257th caller with `rate_limited` is information it can act on.
 */
export const OUTBOUND_QUEUE_DEPTH_DEFAULT = 256;

/** Returns the permit. Idempotent — see `createSemaphore`. */
export type ReleaseFn = () => void;

export type Semaphore = {
  readonly limit: number;
  readonly queueLimit: number;
  /** Resolves with a release function once a permit is available. */
  acquire(signal?: AbortSignal): Promise<ReleaseFn>;
  inFlight(): number;
  queued(): number;
};

export type CreateSemaphoreOptions = {
  limit?: number;
  queueLimit?: number;
};

function assertBound(value: number, min: number, max: number, stage: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    // Refused, not clamped. Serving 512 when the operator asked for 5000 would be a
    // protection that quietly lies about the value it is enforcing.
    throw new RouterError("invalid_route_config", stage);
  }
  return value;
}

type Waiter = {
  resolve: (release: ReleaseFn) => void;
  reject: (error: Error) => void;
  /** Removes the abort listener; called however the waiter leaves the queue. */
  cleanup: () => void;
};

/**
 * A bounded counting semaphore with a bounded wait queue.
 *
 * Two properties do the real work and both are asserted:
 *
 * 1. **A release is idempotent.** Each `acquire` hands back a closure over a private
 *    flag, so calling it twice returns one permit. Without this a `finally` that runs
 *    alongside an error path would hand back two, and the cap would drift upward until
 *    it stopped capping anything — the worst kind of failure, because it looks fine.
 * 2. **An abandoned waiter leaves the queue.** An aborted caller is removed rather
 *    than left holding a position, and a permit is never handed to a departed waiter
 *    and lost; the pump skips over the dead entry to the next live one.
 */
export function createSemaphore(options: CreateSemaphoreOptions = {}): Semaphore {
  const limit = assertBound(
    options.limit ?? OUTBOUND_CONCURRENCY_DEFAULT,
    OUTBOUND_CONCURRENCY_MIN,
    OUTBOUND_CONCURRENCY_MAX,
    "concurrency-limit",
  );
  const queueLimit = assertBound(
    options.queueLimit ?? OUTBOUND_QUEUE_DEPTH_DEFAULT,
    1,
    100_000,
    "concurrency-queue",
  );

  let inFlight = 0;
  const waiters: Array<Waiter | undefined> = [];
  let live = 0;

  const makeRelease = (): ReleaseFn => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      inFlight -= 1;
      pump();
    };
  };

  function pump(): void {
    while (inFlight < limit && live > 0) {
      const next = waiters.shift();
      if (next === undefined) {
        // A slot vacated by an aborted waiter. Skip it rather than counting it as a
        // handoff, or the permit would be consumed by nobody.
        continue;
      }
      live -= 1;
      inFlight += 1;
      next.cleanup();
      next.resolve(makeRelease());
    }
    if (live === 0) {
      // Compact only when the queue is logically empty, so the array cannot grow
      // without bound across a long run of aborts.
      waiters.length = 0;
    }
  }

  return {
    limit,
    queueLimit,

    acquire(signal?: AbortSignal): Promise<ReleaseFn> {
      if (signal?.aborted === true) {
        // Checked before a permit is taken, so an already-cancelled request costs
        // nothing and cannot occupy a slot it will never use.
        return Promise.reject(new ProviderError("unreachable", "concurrency-aborted"));
      }
      if (inFlight < limit) {
        inFlight += 1;
        return Promise.resolve(makeRelease());
      }
      if (live >= queueLimit) {
        return Promise.reject(new RouterError("rate_limited", "concurrency-queue-full"));
      }

      return new Promise<ReleaseFn>((resolve, reject) => {
        const index = waiters.length;
        const onAbort = (): void => {
          if (waiters[index] !== undefined) {
            waiters[index] = undefined;
            live -= 1;
            reject(new ProviderError("unreachable", "concurrency-aborted"));
          }
        };
        const waiter: Waiter = {
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener("abort", onAbort),
        };
        waiters.push(waiter);
        live += 1;
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    inFlight: () => inFlight,
    queued: () => live,
  };
}

/*
 * The process-wide limiter.
 *
 * Per-process, not per-provider, because sockets and file descriptors are a process
 * resource. Twenty providers with a cap of 32 each would open 640 sockets while every
 * individual cap looked perfectly respected — the arithmetic that makes per-resource
 * limits useless.
 */
let shared: Semaphore | undefined;

export function outboundSemaphore(): Semaphore {
  shared ??= createSemaphore();
  return shared;
}

/**
 * Replace the process-wide limiter.
 *
 * The new semaphore is built *before* the old one is dropped, so an invalid limit
 * throws and leaves the previous cap in force rather than leaving the process
 * uncapped.
 */
export function configureOutboundConcurrency(options: CreateSemaphoreOptions): Semaphore {
  const next = createSemaphore(options);
  shared = next;
  return next;
}

/** Restore the default. Exists for tests and for a configuration reload. */
export function resetOutboundConcurrency(): void {
  shared = undefined;
}
