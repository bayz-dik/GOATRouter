import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * How exposed this listener is, derived from the address it binds.
 *
 * Derived, never configured. A flag would let an operator bind `0.0.0.0` and declare
 * it `loopback`, which is exactly the silent downgrade the ladder exists to prevent.
 */
export type BayzPosture = "loopback" | "lan" | "remote";

export const POSTURES: readonly BayzPosture[] = Object.freeze([
  "loopback",
  "lan",
  "remote",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

/** Strip IPv6 brackets and any zone index so classification sees the address. */
function bareAddress(host: string): string {
  const unbracketed =
    host.startsWith("[") && host.includes("]")
      ? host.slice(1, host.indexOf("]"))
      : host;
  const zoneless = unbracketed.split("%")[0]!;
  return zoneless.trim().toLowerCase();
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  // RFC 1918 plus RFC 3927 link-local and RFC 6598 carrier-grade NAT. All three are
  // "reachable by someone else on this network but not routable from the internet",
  // which is precisely the `lan` threat model.
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

function isPrivateIpv6(address: string): boolean {
  // fc00::/7 unique-local and fe80::/10 link-local.
  if (/^f[cd][0-9a-f]{0,2}:/.test(address)) {
    return true;
  }
  return /^fe[89ab][0-9a-f]?:/.test(address);
}

/**
 * Classify a bind address.
 *
 * A wildcard (`0.0.0.0`, `::`) is **`remote`**, not `lan`. It binds every interface
 * the host has, including any public one, so treating it as merely local would be the
 * single most dangerous misclassification available.
 *
 * An unresolvable hostname is also `remote`: it cannot be shown to be local, and the
 * safe direction for an unknown is the strictest posture.
 */
export function derivePosture(host: string): BayzPosture {
  if (typeof host !== "string" || host.trim().length === 0) {
    return "remote";
  }
  const address = bareAddress(host);
  if (LOOPBACK_HOSTS.has(address)) {
    return "loopback";
  }
  // Any 127.x.x.x is loopback, not just 127.0.0.1.
  if (isIP(address) === 4 && address.startsWith("127.")) {
    return "loopback";
  }
  if (address === "0.0.0.0" || address === "::" || address === "*") {
    return "remote";
  }
  if (isIP(address) === 4) {
    return isPrivateIpv4(address) ? "lan" : "remote";
  }
  if (isIP(address) === 6) {
    return isPrivateIpv6(address) ? "lan" : "remote";
  }
  // A name. `localhost` was already handled; anything else is not demonstrably local.
  return "remote";
}

/** Requests-per-window budgets, tightened as exposure rises. */
export type PostureLimits = {
  readonly max: number;
  readonly authMax: number;
  /** In-flight request cap. Absent for loopback, where the OS is the only limit. */
  readonly concurrency: number;
};

/**
 * Limits per posture.
 *
 * `loopback` keeps the Phase 6 numbers exactly, so today's behaviour is unchanged — a
 * regression guard asserts it. Exposure tightens both budgets and adds a concurrency
 * cap, because a reachable listener can be flooded by someone who is not the operator.
 */
export const POSTURE_LIMITS: Readonly<Record<BayzPosture, PostureLimits>> = Object.freeze({
  loopback: { max: 120, authMax: 10, concurrency: 64 },
  lan: { max: 60, authMax: 5, concurrency: 32 },
  remote: { max: 30, authMax: 3, concurrency: 16 },
});

/** Every protection a posture demands, as data rather than as branching. */
export type PostureRequirement =
  | "explicit_remote_opt_in"
  | "explicit_api_token"
  | "tls"
  | "client_authentication";

export const POSTURE_REQUIREMENTS: Readonly<
  Record<BayzPosture, readonly PostureRequirement[]>
> = Object.freeze({
  loopback: Object.freeze([]),
  lan: Object.freeze(["explicit_remote_opt_in", "explicit_api_token", "tls"] as const),
  remote: Object.freeze([
    "explicit_remote_opt_in",
    "explicit_api_token",
    "tls",
    "client_authentication",
  ] as const),
});

export class PostureError extends Error {
  readonly posture: BayzPosture;
  readonly requirement: PostureRequirement;

  constructor(posture: BayzPosture, requirement: PostureRequirement, message: string) {
    super(message);
    this.name = "PostureError";
    this.posture = posture;
    this.requirement = requirement;
  }
}

export type PostureInputs = {
  host: string;
  env?: Record<string, string | undefined>;
  /**
   * Whether the resolved API token was supplied by the operator rather than generated.
   *
   * Passed in rather than read from the environment, because the runtime may have
   * resolved a *stored* token, which is also explicit — the operator kept it.
   */
  apiTokenExplicit?: boolean;
};

export type ResolvedPosture = {
  readonly posture: BayzPosture;
  readonly limits: PostureLimits;
  /** True when `admin` must be refused over a non-loopback connection. */
  readonly denyAdminOverWire: boolean;
  readonly tls: boolean;
  readonly mutualTls: boolean;
  readonly requestSigning: boolean;
};

function has(env: Record<string, string | undefined>, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Derive the posture and refuse to start unless every mandatory protection is present.
 *
 * Each absence raises a distinct `PostureError` naming the missing requirement. That
 * matters more than it looks: a single generic "insecure configuration" error would let
 * an operator fix one thing, restart, hit the same message, and conclude the software
 * is broken. It also makes "no silent downgrade" mechanically testable — the suite
 * enumerates every requirement per posture and asserts each one fails on its own.
 *
 * Nothing here warns. A `lan` or `remote` listener missing TLS is a startup failure,
 * because a warning printed to a log the operator is not reading is indistinguishable
 * from no protection at all.
 */
export function resolvePosture(inputs: PostureInputs): ResolvedPosture {
  const env = inputs.env ?? {};
  const posture = derivePosture(inputs.host);

  const tls = has(env, "BAYZ_TLS_CERT") && has(env, "BAYZ_TLS_KEY");
  const mutualTls = tls && has(env, "BAYZ_TLS_CLIENT_CA");
  const requestSigning = env.BAYZ_REQUIRE_SIGNING === "true";

  for (const requirement of POSTURE_REQUIREMENTS[posture]) {
    switch (requirement) {
      case "explicit_remote_opt_in":
        if (env.BAYZ_ALLOW_REMOTE !== "true") {
          throw new PostureError(
            posture,
            requirement,
            `Binding a ${posture} address requires BAYZ_ALLOW_REMOTE=true`,
          );
        }
        break;
      case "explicit_api_token":
        if (inputs.apiTokenExplicit !== true) {
          throw new PostureError(
            posture,
            requirement,
            `Binding a ${posture} address requires an explicit BAYZ_API_TOKEN; a generated token is refused`,
          );
        }
        break;
      case "tls":
        if (!tls) {
          throw new PostureError(
            posture,
            requirement,
            `Binding a ${posture} address requires TLS: set BAYZ_TLS_CERT and BAYZ_TLS_KEY`,
          );
        }
        break;
      case "client_authentication":
        // Either is sufficient, neither is optional. mTLS proves the client at the
        // transport, signing proves each request; a `remote` listener with only a
        // bearer token is one leaked header away from full access.
        if (!mutualTls && !requestSigning) {
          throw new PostureError(
            posture,
            requirement,
            "Binding a remote address requires mutual TLS (BAYZ_TLS_CLIENT_CA) or request signing (BAYZ_REQUIRE_SIGNING=true)",
          );
        }
        break;
    }
  }

  return {
    posture,
    limits: POSTURE_LIMITS[posture],
    // Management of the deployment stays on the machine. An admin key is the highest
    // authority BAYZ has, and letting it cross a network turns one leaked header into
    // provider credentials, proxy passwords, and root-key rotation.
    denyAdminOverWire: posture !== "loopback",
    tls,
    mutualTls,
    requestSigning,
  };
}

/** Is this peer address on the local machine? */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (typeof address !== "string" || address.length === 0) {
    // An unknown peer is treated as remote: the safe direction for an unknown.
    return false;
  }
  const bare = bareAddress(address);
  if (LOOPBACK_HOSTS.has(bare)) {
    return true;
  }
  if (isIP(bare) === 4 && bare.startsWith("127.")) {
    return true;
  }
  // IPv4-mapped IPv6 loopback, which is what a dual-stack listener reports.
  return bare === "::ffff:127.0.0.1" || bare.startsWith("::ffff:127.");
}

/**
 * The Host values a request must carry to reach this listener.
 *
 * A server is reached by whatever a client puts in the `Host` header, which
 * must be one of the addresses the bound socket actually answers — the value
 * the operator chose (`BAYZ_HOST`) plus, for a wildcard, every interface that
 * wildcard binds. That is how a legitimate client names the server (opening
 * `https://<lan-ip>:<port>` in a browser sends the LAN IP as Host); anything
 * else is a DNS-rebinding or cross-site attempt and stays refused.
 *
 * A concrete bind contributes that single value. A wildcard bind (`0.0.0.0`,
 * `::`) contributes every non-loopback, non-link-local local interface,
 * because it answers on all of them. A hostname bind contributes the name as
 * written. An empty value contributes nothing and the caller's loopback
 * defaults still stand.
 */
export function hostsForBind(bind: string | undefined): string[] {
  if (typeof bind !== "string" || bind.length === 0) {
    return [];
  }
  const bare = bareAddress(bind).toLowerCase();
  if (isIP(bare) === 0) {
    // A hostname. Its addresses cannot be known without a DNS call; the name
    // itself is what a client puts in `Host`, so allowing it is both correct
    // and complete.
    return [bare];
  }
  if (bare === "0.0.0.0" || bare === "::" || bare === "*") {
    const hosts: string[] = [];
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal) {
          // Loopback is already in the guard's default set; skip it here.
          continue;
        }
        const a = entry.address.toLowerCase();
        if (entry.family === "IPv6" && a.startsWith("fe8")) {
          // Link-local needs a zone id to be reachable from another host.
          continue;
        }
        hosts.push(a);
      }
    }
    return [...new Set(hosts)];
  }
  // A concrete loopback address needs nothing beyond itself, which is already
  // in the guard's default set; a concrete non-loopback address contributes
  // itself — the address a LAN client puts in `Host`.
  return [bare];
}
