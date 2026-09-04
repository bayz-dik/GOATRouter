import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStorage } from "@bayz/storage";

/** The reserved secret name holding the local API token. */
export const API_TOKEN_SECRET_NAME = "api:token";
const TOKEN_BYTES = 32;
const MIN_ENV_TOKEN_LENGTH = 16;

export type ApiTokenSource = "environment" | "stored" | "generated";

export type ResolvedApiToken = {
  token: string;
  source: ApiTokenSource;
};

/**
 * Mint a fresh 64-hex API token.
 *
 * Rotation must mint a replacement that is indistinguishable from a first-boot
 * generation in strength (32 random bytes, hex), so a rotated credential is not
 * weaker than one that was never rotated.
 */
export function mintApiToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export type ResolveApiTokenOptions = {
  storage: SecretStorage;
  env?: Record<string, string | undefined>;
  /** Called only when a token is newly generated, exactly once. */
  notify?: (line: string) => void;
};

/**
 * Resolve the local API token.
 *
 * `BAYZ_API_TOKEN` wins when present and is deliberately *not* copied into the
 * database: an operator managing secrets externally (systemd, a container secret
 * mount) should not end up with a second, stale copy at rest.
 *
 * Otherwise the token lives in the same envelope-encrypted store as every
 * provider key, and is printed exactly once at generation. There is no accessor
 * that returns it afterwards, and no endpoint exposes it.
 */
export function resolveApiToken(
  options: ResolveApiTokenOptions,
): ResolvedApiToken {
  const env = options.env ?? {};
  const notify = options.notify ?? (() => {});

  const supplied = env.BAYZ_API_TOKEN;
  if (supplied !== undefined) {
    const trimmed = supplied.trim();
    if (trimmed.length < MIN_ENV_TOKEN_LENGTH) {
      // Refused rather than padded or hashed into something usable: a weak token
      // on a listening socket is worse than a startup failure.
      throw new Error(
        `BAYZ_API_TOKEN must be at least ${MIN_ENV_TOKEN_LENGTH} characters`,
      );
    }
    return { token: trimmed, source: "environment" };
  }

  // A corrupt record propagates as `secret_corrupt` rather than being replaced,
  // so tampering can never cause a silent token rotation.
  const existing = options.storage.find(API_TOKEN_SECRET_NAME);
  if (existing !== undefined) {
    return { token: existing, source: "stored" };
  }

  const token = mintApiToken();
  options.storage.put(API_TOKEN_SECRET_NAME, token);
  notify(
    `Bayz local API token (shown only once, store it now): ${token}`,
  );
  return { token, source: "generated" };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time token comparison.
 *
 * Both sides are hashed first so the buffers are always 32 bytes: comparing raw
 * tokens with `timingSafeEqual` throws on a length mismatch, which would turn
 * length into an oracle and leak through the error path.
 */
export function verifyApiToken(expected: string, presented: unknown): boolean {
  if (typeof presented !== "string" || presented.length === 0) {
    return false;
  }
  return timingSafeEqual(digest(expected), digest(presented));
}
