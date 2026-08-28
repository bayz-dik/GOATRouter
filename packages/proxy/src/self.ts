import { isIP } from "node:net";
import { ProxyError } from "./errors.js";

/**
 * Where this process is listening.
 *
 * Registered by the server at startup, so the proxy layer can refuse a tunnel that
 * targets BAYZ itself. It is a *registry* rather than a compile-time constant because
 * the bind address is configuration: hard-coding `127.0.0.1:20128` would miss a `lan`
 * deployment and miss a non-default port.
 */
export type LocalListener = {
  host: string;
  port: number;
};

/** Normalised `host\u0000port` keys of every registered listener. */
const listeners = new Set<string>();
/** Ports on which a wildcard bind claims every local address. */
const wildcardPorts = new Set<number>();

const LOOPBACK_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", ""]);

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** Drop brackets, any IPv6 zone index, and case. */
function bare(host: string): string {
  return stripBrackets(host.trim()).split("%")[0]!.toLowerCase();
}

/**
 * Parse every numeric form a resolver accepts as IPv4, to a dotted quad.
 *
 * `2130706433`, `127.1`, `0x7f000001`, and `0177.0.0.1` all reach 127.0.0.1. A pivot
 * check that only understood dotted quads would wave all four through, which is the
 * same bypass class `@bayz/providers`' egress filter was built against. This is a
 * deliberate second copy rather than an import: `@bayz/proxy` does not depend on
 * `@bayz/providers` (the dependency runs the other way), and inverting that to share
 * one function would make the proxy layer depend on provider configuration.
 */
function normalizeIpv4(input: string): string | undefined {
  const parts = input.split(".");
  if (parts.length === 0 || parts.length > 4) {
    return undefined;
  }
  const values: number[] = [];
  for (const part of parts) {
    if (part.length === 0) {
      return undefined;
    }
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      value = Number.parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      value = Number.parseInt(part.slice(1), 8);
    } else if (/^(0|[1-9][0-9]*)$/.test(part)) {
      value = Number.parseInt(part, 10);
    } else {
      return undefined;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
      return undefined;
    }
    values.push(value);
  }
  const last = values[values.length - 1]!;
  const leading = values.slice(0, -1);
  if (leading.some((value) => value > 0xff)) {
    return undefined;
  }
  const remaining = 4 - leading.length;
  if (last >= 2 ** (8 * remaining)) {
    return undefined;
  }
  const combined =
    leading.reduce((total, value) => (total << 8) | value, 0) * 2 ** (8 * remaining) + last;
  if (combined > 0xffffffff) {
    return undefined;
  }
  return [
    (combined >>> 24) & 0xff,
    (combined >>> 16) & 0xff,
    (combined >>> 8) & 0xff,
    combined & 0xff,
  ].join(".");
}

/** Is this host, in any spelling, the local machine? */
function isLocalHost(host: string): boolean {
  const value = bare(host);
  if (LOOPBACK_NAMES.has(value)) {
    return true;
  }
  const ipv4 = normalizeIpv4(value);
  if (ipv4 !== undefined) {
    return ipv4.startsWith("127.") || ipv4 === "0.0.0.0";
  }
  if (value === "::1" || value === "0:0:0:0:0:0:0:1" || value === "::") {
    return true;
  }
  // IPv4-mapped loopback, which is what a dual-stack listener reports.
  if (value.startsWith("::ffff:")) {
    const embedded = value.slice("::ffff:".length);
    const mapped = normalizeIpv4(embedded);
    return mapped !== undefined && mapped.startsWith("127.");
  }
  return false;
}

/**
 * Canonical key for a host, so every spelling of one address collides.
 *
 * A name that is not demonstrably local is kept as the name: resolving it here would
 * be a lookup whose answer could differ from the one the proxy performs, and acting on
 * a different answer than the one that matters is worse than not acting.
 */
function hostKey(host: string): string {
  const value = bare(host);
  if (isLocalHost(value)) {
    return "\u0000local";
  }
  const ipv4 = normalizeIpv4(value);
  return ipv4 ?? value;
}

/**
 * Record a listener this process owns.
 *
 * An unusable registration throws rather than being ignored: a registration that
 * silently failed would leave the pivot check believing it protects a listener it knows
 * nothing about, and the operator would have no reason to look.
 */
export function registerLocalListener(listener: LocalListener): void {
  const { host, port } = listener;
  if (typeof host !== "string" || host.trim().length === 0) {
    throw new ProxyError("invalid_proxy_config", "listener-host");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyError("invalid_proxy_config", "listener-port");
  }
  const value = bare(host);
  if (WILDCARD_HOSTS.has(value)) {
    // A wildcard bind claims every interface, so every local address on that port is
    // BAYZ. Recording it as the literal address "0.0.0.0" would leave the actual
    // interface addresses open.
    wildcardPorts.add(port);
    return;
  }
  listeners.add(`${hostKey(value)}\u0000${port}`);
}

export function clearLocalListeners(): void {
  listeners.clear();
  wildcardPorts.clear();
}

export function localListenerCount(): number {
  return listeners.size + wildcardPorts.size;
}

/**
 * Would a tunnel to this target reach BAYZ itself?
 *
 * The match is on the *address and port*, not on address class. A `lan` deployment
 * binds one private address; a different private address is somebody else's machine and
 * is a legitimate proxy target, so refusing everything private would break the feature
 * rather than protect it.
 */
export function isSelfPivot(target: LocalListener): boolean {
  if (listeners.size === 0 && wildcardPorts.size === 0) {
    return false;
  }
  const { host, port } = target;
  if (typeof host !== "string" || !Number.isInteger(port)) {
    return false;
  }
  if (wildcardPorts.has(port) && isLocalHost(host)) {
    return true;
  }
  return listeners.has(`${hostKey(host)}\u0000${port}`);
}

/**
 * Refuse a tunnel that would loop back into this process.
 *
 * Called before any socket is opened. A proxy asked to reach BAYZ's own listener turns
 * the router into a relay into itself: each hop consumes a socket and an outbound
 * permit, and an authenticated request would loop until the process exhausts one or the
 * other. The outbound cap makes that bounded rather than unbounded, which is precisely
 * why the loop is refused outright instead of merely throttled.
 */
export function assertNotSelfPivot(target: LocalListener): void {
  if (isSelfPivot(target)) {
    // `forbidden`, not `invalid_proxy_config`: the configuration is well-formed and
    // the specific destination is what is refused. No host or port in the message.
    throw new ProxyError("forbidden", "dial-self-pivot");
  }
}
