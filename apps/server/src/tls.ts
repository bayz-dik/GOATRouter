import { readFileSync } from "node:fs";

/**
 * The TLS window.
 *
 * 1.2 is the floor because 1.0 and 1.1 are deprecated and have no place terminating
 * a connection that carries provider credentials. 1.3 is the ceiling simply because
 * it is the newest version Node negotiates; naming both as constants means a later
 * edit that widens the window has to change a pinned value a test asserts, rather
 * than silently re-enabling a dead protocol.
 */
export const TLS_MIN_VERSION = "TLSv1.2" as const;
export const TLS_MAX_VERSION = "TLSv1.3" as const;

export type TlsRequirement = "incomplete" | "unreadable";

export class TlsError extends Error {
  readonly requirement: TlsRequirement;

  constructor(requirement: TlsRequirement, message: string) {
    super(message);
    this.name = "TlsError";
    this.requirement = requirement;
  }
}

/**
 * What Fastify needs to terminate TLS, plus what the posture ladder needs to know.
 *
 * Holds file *contents*, never paths. A path retained on a live object is a path that
 * eventually reaches a log line, an error body, or a status response, and the layout
 * of an operator's key material is not something a client should be able to learn.
 */
export type TlsConfig = {
  readonly cert: string;
  readonly key: string;
  readonly ca?: string;
  readonly requestCert: boolean;
  readonly rejectUnauthorized: boolean;
  readonly minVersion: typeof TLS_MIN_VERSION;
  readonly maxVersion: typeof TLS_MAX_VERSION;
  /** True when a client certificate is demanded — i.e. mutual TLS is in force. */
  readonly mutual: boolean;
};

/**
 * Read a PEM file, or fail with a message that names the variable and not the path.
 *
 * The distinction matters: an operator needs to know *which* setting is wrong, which
 * the variable name tells them, and nothing else the message could add helps them
 * more than it helps someone reading their logs.
 */
function readPem(env: Record<string, string | undefined>, variable: string): string {
  const path = env[variable];
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new TlsError("incomplete", `${variable} must be set to a readable PEM file`);
  }
  try {
    const contents = readFileSync(path, "utf8");
    if (contents.trim().length === 0) {
      throw new TlsError("unreadable", `${variable} points at an empty file`);
    }
    return contents;
  } catch (error) {
    if (error instanceof TlsError) {
      throw error;
    }
    // The underlying error carries the path in its message and its stack, so it is
    // deliberately not chained.
    throw new TlsError("unreadable", `${variable} could not be read`);
  }
}

function present(env: Record<string, string | undefined>, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Build the TLS configuration, or `undefined` when TLS was not requested.
 *
 * Half a configuration is refused rather than ignored. A certificate with no key
 * cannot serve TLS, and a client CA with no server certificate would leave an
 * operator believing mutual TLS was in force while the listener spoke plain HTTP —
 * the most consequential kind of silent downgrade there is.
 */
export function loadTlsConfig(
  env: Record<string, string | undefined> = process.env,
): TlsConfig | undefined {
  const wantsCert = present(env, "BAYZ_TLS_CERT");
  const wantsKey = present(env, "BAYZ_TLS_KEY");
  const wantsClientCa = present(env, "BAYZ_TLS_CLIENT_CA");

  if (!wantsCert && !wantsKey && !wantsClientCa) {
    return undefined;
  }
  if (!wantsCert || !wantsKey) {
    throw new TlsError(
      "incomplete",
      "TLS requires both BAYZ_TLS_CERT and BAYZ_TLS_KEY; a partial configuration is refused",
    );
  }

  const cert = readPem(env, "BAYZ_TLS_CERT");
  const key = readPem(env, "BAYZ_TLS_KEY");
  const ca = wantsClientCa ? readPem(env, "BAYZ_TLS_CLIENT_CA") : undefined;

  return {
    cert,
    key,
    ...(ca === undefined ? {} : { ca }),
    // `requestCert` alone would ask for a certificate and accept its absence.
    // Pairing it with `rejectUnauthorized` is what makes mTLS mandatory for the
    // clients of a listener that configured it.
    requestCert: ca !== undefined,
    rejectUnauthorized: ca !== undefined,
    minVersion: TLS_MIN_VERSION,
    maxVersion: TLS_MAX_VERSION,
    mutual: ca !== undefined,
  };
}

/** The shape Fastify's `https` option expects, derived from a `TlsConfig`. */
export function fastifyHttpsOptions(config: TlsConfig): Record<string, unknown> {
  return {
    cert: config.cert,
    key: config.key,
    ...(config.ca === undefined ? {} : { ca: config.ca }),
    requestCert: config.requestCert,
    rejectUnauthorized: config.rejectUnauthorized,
    minVersion: config.minVersion,
    maxVersion: config.maxVersion,
  };
}
