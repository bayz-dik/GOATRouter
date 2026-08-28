import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errorEnvelope } from "./http-errors.js";

/** Headers a signed request carries. Lowercase, because Node normalises them. */
export const TIMESTAMP_HEADER = "x-bayz-timestamp";
export const NONCE_HEADER = "x-bayz-nonce";
export const SIGNATURE_HEADER = "x-bayz-signature";

/**
 * How far a client clock may drift, either direction.
 *
 * 60s is a compromise with a reason on both sides: shorter and an unsynchronised
 * laptop cannot talk to the router at all; longer and a captured request stays
 * replayable for longer than the nonce cache can be relied on to remember it.
 */
export const SIGNING_SKEW_MS = 60_000;

/** How many recent nonces are remembered. Bounded on purpose — see `createNonceCache`. */
export const NONCE_CACHE_MAX = 4096;

const HEX_64 = /^[0-9a-f]{64}$/;
/** Long enough to be unguessable, short enough that a flood cannot be built from it. */
const MAX_NONCE_LENGTH = 128;

export type CanonicalInput = {
  method: string;
  /** Path **and** query. A signature over the path alone would leave parameters free. */
  url: string;
  body: string;
  at: number;
  nonce: string;
};

/**
 * The exact bytes that get signed.
 *
 * Newline-joined fields with the body committed as a hash rather than inlined: a 1 MiB
 * body would otherwise be copied into this string and hashed twice, and the hash binds
 * it just as tightly.
 *
 * Every field is bound, and a test enumerates them and asserts that varying each one
 * changes the string — so a component added here without being covered fails loudly
 * instead of being silently unauthenticated.
 */
export function canonicalRequest(input: CanonicalInput): string {
  const bodyHash = createHash("sha256").update(input.body, "utf8").digest("hex");
  return [
    "BAYZ-HMAC-SHA256",
    input.method.toUpperCase(),
    input.url,
    String(input.at),
    input.nonce,
    bodyHash,
  ].join("\n");
}

export type SignInput = {
  key: string;
  method: string;
  url: string;
  body?: string;
  at?: number;
  nonce?: string;
};

/**
 * Produce the three headers for a request.
 *
 * Exported and used by the tests and the security smoke rather than being reimplemented
 * there: a test that builds its own signature proves only that two implementations
 * agree, not that the shipped one is correct.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const at = input.at ?? Date.now();
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const signature = createHmac("sha256", input.key)
    .update(
      canonicalRequest({
        method: input.method,
        url: input.url,
        body: input.body ?? "",
        at,
        nonce,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    [TIMESTAMP_HEADER]: String(at),
    [NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: signature,
  };
}

export type NonceCache = {
  /** True if this nonce is new; false if it has been seen. */
  remember(nonce: string): boolean;
  size(): number;
};

/**
 * A bounded FIFO of recently seen nonces.
 *
 * Bounded is a deliberate, stated limitation rather than an oversight: an unbounded
 * cache is a memory leak an attacker controls by sending distinct nonces. Replay
 * protection is therefore the *conjunction* of this cache and the timestamp window —
 * a replay only succeeds if it arrives late enough for its nonce to have been evicted
 * yet early enough to still be inside ±`SIGNING_SKEW_MS`. At 4096 entries that
 * requires sustaining thousands of signed requests within a minute, which the rate
 * limiter already refuses.
 */
export function createNonceCache(max: number = NONCE_CACHE_MAX): NonceCache {
  // A Set preserves insertion order in JS, so the oldest key is the first iterated.
  const seen = new Set<string>();
  return {
    remember(nonce: string): boolean {
      if (seen.has(nonce)) {
        return false;
      }
      seen.add(nonce);
      if (seen.size > max) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }
      return true;
    },
    size(): number {
      return seen.size;
    },
  };
}

/**
 * Compare two hex digests in constant time.
 *
 * Both sides are hashed to a fixed 32 bytes first. `timingSafeEqual` throws on a
 * length mismatch, so passing raw values would turn length into an oracle that leaks
 * through the error path — the same reasoning as `verifyApiToken` and the identity
 * manager's key comparison.
 */
function digestsMatch(expected: string, presented: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(expected, "utf8").digest(),
    createHash("sha256").update(presented, "utf8").digest(),
  );
}

/** Where the raw request body is stashed for hashing. */
declare module "fastify" {
  interface FastifyRequest {
    /**
     * The body exactly as it arrived, kept only when request signing is enabled.
     *
     * Re-serialising the parsed object would not reproduce the bytes the client
     * signed — key order, whitespace, and number formatting all differ — so the
     * signature would fail for correct clients.
     */
    rawBody?: string;
  }
}

const SIGNED_HEADER_NAMES = [TIMESTAMP_HEADER, NONCE_HEADER, SIGNATURE_HEADER] as const;

function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  // A duplicated header arrives as an array. Picking one would let an attacker send
  // a valid signature alongside a hostile one, so it is refused outright.
  return typeof value === "string" ? value : undefined;
}

export type InstallSigningOptions = {
  /** The presented bearer for a request, i.e. the HMAC key. */
  keyFor: (request: FastifyRequest) => string | undefined;
  /** Paths that are never signature-gated. */
  exempt: (request: FastifyRequest) => boolean;
  nonceCache?: NonceCache;
  now?: () => number;
};

/**
 * Require a valid signature on every guarded request.
 *
 * Verification runs at `preValidation`, not `onRequest`, because the body has to exist
 * to be hashed. Authentication has already happened by then, so a caller that fails
 * here presented a real credential — which is why the refusals are distinguishable
 * (`stale`, `replayed`, `invalid`) for the operator's benefit while none of them
 * reveals the expected signature.
 */
export function installRequestSigning(
  app: FastifyInstance,
  options: InstallSigningOptions,
): void {
  const cache = options.nonceCache ?? createNonceCache();
  const now = options.now ?? (() => Date.now());

  /*
   * Keep the raw body.
   *
   * Registered only when signing is on, so the default JSON parsing path — and every
   * error code the Phase 6 error map already covers — is untouched for every existing
   * install. The `FST_ERR_CTP_INVALID_JSON` code is set explicitly so a malformed body
   * still maps to the same clean 400 rather than a 500.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      const raw = typeof body === "string" ? body : String(body);
      request.rawBody = raw;
      if (raw.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch {
        const error = new Error("Body is not valid JSON") as Error & {
          statusCode?: number;
          code?: string;
        };
        error.statusCode = 400;
        error.code = "FST_ERR_CTP_INVALID_JSON";
        done(error, undefined);
      }
    },
  );

  const refuse = (
    request: FastifyRequest,
    reply: FastifyReply,
    code: string,
    message: string,
  ): FastifyReply =>
    reply
      .code(401)
      .header("www-authenticate", "Bearer")
      .send(errorEnvelope(request, code, message));

  app.addHook("preValidation", async (request, reply) => {
    if (options.exempt(request)) {
      return;
    }
    const key = options.keyFor(request);
    if (key === undefined) {
      // Unauthenticated requests were already refused by the auth guard; reaching
      // here without a key means the route is not guarded at all.
      return;
    }

    for (const name of SIGNED_HEADER_NAMES) {
      if (headerOf(request, name) === undefined) {
        // One message for all three: naming the missing header would hand an attacker
        // a checklist for building a well-formed request.
        return refuse(
          request,
          reply,
          "signature_required",
          "This deployment requires signed requests",
        );
      }
    }

    const timestampRaw = headerOf(request, TIMESTAMP_HEADER)!;
    const nonce = headerOf(request, NONCE_HEADER)!;
    const presented = headerOf(request, SIGNATURE_HEADER)!;

    // Shape first, so a hostile value is rejected before any HMAC is computed.
    if (!/^[0-9]{1,15}$/.test(timestampRaw)) {
      return refuse(request, reply, "signature_invalid", "The request signature is invalid");
    }
    if (nonce.length === 0 || nonce.length > MAX_NONCE_LENGTH) {
      return refuse(request, reply, "signature_invalid", "The request signature is invalid");
    }
    if (!HEX_64.test(presented)) {
      return refuse(request, reply, "signature_invalid", "The request signature is invalid");
    }

    const at = Number(timestampRaw);
    if (Math.abs(now() - at) > SIGNING_SKEW_MS) {
      return refuse(
        request,
        reply,
        "signature_stale",
        "The request timestamp is outside the accepted window",
      );
    }

    const expected = createHmac("sha256", key)
      .update(
        canonicalRequest({
          method: request.method,
          url: request.url,
          body: request.rawBody ?? "",
          at,
          nonce,
        }),
        "utf8",
      )
      .digest("hex");

    if (!digestsMatch(expected, presented)) {
      return refuse(request, reply, "signature_invalid", "The request signature is invalid");
    }

    // The nonce is spent only after the signature verified. Consuming it first would
    // let an unauthenticated flood of guesses evict every legitimate entry.
    if (!cache.remember(nonce)) {
      return refuse(
        request,
        reply,
        "signature_replayed",
        "This request has already been seen",
      );
    }
  });
}
