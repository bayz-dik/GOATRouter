import { isIP } from "node:net";
import { ProviderError } from "./errors.js";

export type EgressPolicy = {
  /** Local model runtimes are a first-class use case, so this is opt-in per provider. */
  allowLoopback: boolean;
  /** A LAN-hosted relay is legitimate but must be chosen deliberately. */
  allowPrivate: boolean;
};

/** Deny by default. An operator opts into loopback or LAN, never the reverse. */
export const DEFAULT_EGRESS_POLICY: EgressPolicy = Object.freeze({
  allowLoopback: false,
  allowPrivate: false,
});

const MAX_HOSTNAME_LENGTH = 253;
/** A conservative DNS name: labels of alphanumerics and hyphens, no leading hyphen. */
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.(?!-)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;

/**
 * Hostnames that resolve to a local or metadata service by convention.
 *
 * These are matched by *name* because the address check alone would miss them: a
 * cloud provider can point `metadata.google.internal` anywhere, and a resolver can be
 * configured to answer `localhost` with a public address.
 */
const DENIED_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "169.254.169.254.nip.io",
]);

type Ipv4 = readonly [number, number, number, number];

function ipv4From(value: number): Ipv4 {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

/**
 * Parse every numeric form a resolver will accept as an IPv4 address.
 *
 * This is the part that matters most. `fetch("http://2130706433")` reaches
 * 127.0.0.1, and so do `127.1`, `0177.0.0.1`, and `0x7f000001`. A validator that only
 * understood dotted quads would wave all of them through, which is exactly how SSRF
 * filters get bypassed in practice. Each part may be decimal, octal (leading zero), or
 * hex (`0x`), and a short form spreads its last part across the remaining octets.
 */
function parseLooseIpv4(input: string): Ipv4 | undefined {
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
  // The final part absorbs the remaining octets: `127.1` is 127.0.0.1.
  const remainingOctets = 4 - leading.length;
  if (last >= 2 ** (8 * remainingOctets)) {
    return undefined;
  }

  const combined =
    leading.reduce((total, value) => (total << 8) | value, 0) *
      2 ** (8 * remainingOctets) +
    last;
  if (combined > 0xffffffff) {
    return undefined;
  }
  return ipv4From(combined);
}

function inRange(address: Ipv4, prefix: readonly number[], bits: number): boolean {
  const value =
    ((address[0] << 24) | (address[1] << 16) | (address[2] << 8) | address[3]) >>> 0;
  const target =
    (((prefix[0] ?? 0) << 24) |
      ((prefix[1] ?? 0) << 16) |
      ((prefix[2] ?? 0) << 8) |
      (prefix[3] ?? 0)) >>>
    0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (target & mask);
}

type Classification = "loopback" | "private" | "denied" | "public";

function classifyIpv4(address: Ipv4): Classification {
  if (inRange(address, [127, 0, 0, 0], 8)) {
    return "loopback";
  }
  if (inRange(address, [0, 0, 0, 0], 8)) {
    // 0.0.0.0/8 includes "this host on this network"; 0.0.0.0 itself routes to local.
    return "loopback";
  }
  if (inRange(address, [169, 254, 0, 0], 16)) {
    // Link-local, which is where every cloud metadata service lives. Never allowed.
    return "denied";
  }
  if (
    inRange(address, [224, 0, 0, 0], 4) ||
    inRange(address, [240, 0, 0, 0], 4) ||
    inRange(address, [192, 0, 2, 0], 24) ||
    inRange(address, [198, 51, 100, 0], 24) ||
    inRange(address, [203, 0, 113, 0], 24) ||
    inRange(address, [192, 0, 0, 0], 24) ||
    inRange(address, [198, 18, 0, 0], 15)
  ) {
    // Multicast, reserved, documentation, and benchmarking ranges. None is a provider.
    return "denied";
  }
  if (
    inRange(address, [10, 0, 0, 0], 8) ||
    inRange(address, [172, 16, 0, 0], 12) ||
    inRange(address, [192, 168, 0, 0], 16) ||
    inRange(address, [100, 64, 0, 0], 10)
  ) {
    return "private";
  }
  return "public";
}

function classifyIpv6(input: string): Classification {
  const normalized = input.toLowerCase();

  // An IPv4-mapped address must be judged by its IPv4 value, or `::ffff:127.0.0.1`
  // would pass an IPv6-only check and then connect to loopback.
  const mapped = /^::ffff:(.+)$/.exec(normalized);
  if (mapped !== undefined && mapped !== null) {
    const embedded = mapped[1]!;
    const parsed = parseLooseIpv4(embedded);
    if (parsed !== undefined) {
      return classifyIpv4(parsed);
    }
    // `::ffff:7f00:1` is the hex form of the same thing.
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(embedded);
    if (hex !== null) {
      const high = Number.parseInt(hex[1]!, 16);
      const low = Number.parseInt(hex[2]!, 16);
      return classifyIpv4(ipv4From(((high << 16) | low) >>> 0));
    }
  }
  // The same hex form without the `ffff` marker, as `0:0:0:0:0:ffff:7f00:1` expands.
  const fullMapped = /^(?:0:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (fullMapped !== null) {
    const high = Number.parseInt(fullMapped[1]!, 16);
    const low = Number.parseInt(fullMapped[2]!, 16);
    return classifyIpv4(ipv4From(((high << 16) | low) >>> 0));
  }

  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return "loopback";
  }
  if (normalized === "::" || /^0(:0)*$/.test(normalized)) {
    return "loopback";
  }
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) {
    // fe80::/10 link-local.
    return "denied";
  }
  if (/^ff[0-9a-f][0-9a-f]:/.test(normalized)) {
    // ff00::/8 multicast.
    return "denied";
  }
  if (/^f[cd][0-9a-f][0-9a-f]:/.test(normalized)) {
    // fc00::/7 unique local.
    return "private";
  }
  return "public";
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function classify(hostname: string): Classification {
  const trimmed = hostname.trim();
  const bracketed = trimmed.startsWith("[") && trimmed.endsWith("]");
  const bare = stripBrackets(trimmed);
  const lower = bare.toLowerCase().replace(/\.$/, "");

  if (DENIED_NAMES.has(lower)) {
    return lower.startsWith("metadata") || lower.startsWith("instance-data")
      ? "denied"
      : "loopback";
  }

  // Bracket form declares an IPv6 literal. `[not-an-ip]` is therefore malformed
  // rather than a hostname that happens to look like one.
  if (bracketed) {
    return isIP(bare) === 6 ? classifyIpv6(bare) : "denied";
  }

  if (isIP(bare) === 6) {
    return classifyIpv6(bare);
  }
  if (bare.includes(":")) {
    // A colon that is not a valid IPv6 address means the caller passed a URL, an
    // authority with a port, or userinfo. Treating it as IPv6 would classify
    // `http://example.com` as public and let it through — this must be refused, and
    // it is the caller's job to pass a bare hostname.
    return "denied";
  }

  const ipv4 = parseLooseIpv4(bare);
  if (ipv4 !== undefined) {
    return classifyIpv4(ipv4);
  }

  if (!HOSTNAME_RE.test(bare)) {
    // Not an address and not a well-formed name. Refusing rather than resolving keeps
    // a control character or an embedded URL from reaching the resolver at all.
    return "denied";
  }
  // A final label of pure digits is never a real TLD, so this is a malformed address
  // rather than a hostname — `999.999.999.999` reaches here after `parseLooseIpv4`
  // rejects it, and classifying it as a public *name* would let it through.
  if (/(^|\.)[0-9]+\.?$/.test(bare)) {
    return "denied";
  }
  return "public";
}

function permitted(classification: Classification, policy: EgressPolicy): boolean {
  switch (classification) {
    case "public":
      return true;
    case "loopback":
      return policy.allowLoopback;
    case "private":
      return policy.allowPrivate;
    case "denied":
      // Link-local, metadata, multicast, reserved, and malformed. No flag reaches
      // these: an SSRF against a cloud metadata service is never a legitimate
      // provider target, however the operator has configured things.
      return false;
  }
}

/**
 * Refuse a provider hostname that must never be dialled.
 *
 * Runs at configuration time, so a provider targeting `169.254.169.254` cannot be
 * stored at all. The error names no hostname: the rejected value is operator- or
 * attacker-controlled text that reaches logs.
 */
export function assertEgressAllowed(hostname: string, policy: EgressPolicy): void {
  if (typeof hostname !== "string") {
    throw new ProviderError("invalid_provider_config", "egress-hostname-type");
  }
  const trimmed = hostname.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HOSTNAME_LENGTH + 2) {
    throw new ProviderError("invalid_provider_config", "egress-hostname-length");
  }
  if (!permitted(classify(trimmed), policy)) {
    throw new ProviderError("invalid_provider_config", "egress-denied");
  }
}

export function isEgressAllowed(hostname: unknown, policy: EgressPolicy): boolean {
  try {
    assertEgressAllowed(hostname as string, policy);
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-check a *resolved* address immediately before connect.
 *
 * Deliberately separate from `assertEgressAllowed`. A hostname approved at
 * configuration time can resolve to a private address later, so the check has to run
 * against what DNS actually returned. This **narrows** the DNS-rebinding window; it
 * does not eliminate it, because Node offers no hook between the resolution a socket
 * performs and its own connect for that same resolution. The honest guarantee is
 * "an address BAYZ has seen is checked", not "rebinding is impossible".
 *
 * Only accepts an address. A hostname arriving here means the caller wired it up
 * wrong, and accepting it would skip the check entirely.
 */
export function assertResolvedAddressAllowed(
  address: string,
  policy: EgressPolicy,
): void {
  if (typeof address !== "string" || isIP(stripBrackets(address.trim())) === 0) {
    throw new ProviderError("invalid_provider_config", "egress-resolved-not-address");
  }
  if (!permitted(classify(address), policy)) {
    throw new ProviderError("invalid_provider_config", "egress-resolved-denied");
  }
}
