import { ProxyError } from "./errors.js";

export const PROXY_KINDS = ["socks5", "http"] as const;
export type ProxyKind = (typeof PROXY_KINDS)[number];

const PROXY_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_INNER_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const MAX_HOST_LENGTH = 253;

export type ProxyEndpoint = {
  host: string;
  port: number;
};

export function isProxyKind(value: unknown): value is ProxyKind {
  return typeof value === "string" && (PROXY_KINDS as readonly string[]).includes(value);
}

export function assertProxyKind(value: unknown): ProxyKind {
  if (!isProxyKind(value)) {
    throw new ProxyError("invalid_proxy_config", "proxy-kind");
  }
  return value;
}

/**
 * Proxy ids reuse the provider id alphabet: the id becomes part of the physical
 * secret name `proxy:<id>:password`, so any character that could break out of a
 * scope must be impossible here too.
 */
export function assertProxyId(id: unknown): string {
  if (
    typeof id !== "string" ||
    !PROXY_ID_RE.test(id) ||
    id.includes("..") ||
    id.endsWith("-")
  ) {
    throw new ProxyError("invalid_proxy_id", "proxy-id");
  }
  return id;
}

function isIpv4(value: string): boolean {
  const match = IPV4_RE.exec(value);
  if (match === null) {
    return false;
  }
  return match.slice(1).every((octet) => {
    const numeric = Number(octet);
    return (
      String(numeric) === octet.replace(/^0+(?=\d)/, "") &&
      numeric >= 0 &&
      numeric <= 255
    );
  });
}

function isBracketedIpv6(value: string): boolean {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    return false;
  }
  const inner = value.slice(1, -1);
  if (!IPV6_INNER_RE.test(inner) || !inner.includes(":")) {
    return false;
  }
  // Reject a second `::` run and any group that is not 1-4 hex digits; anything
  // else would be handed to the socket layer as a hostname and fail confusingly.
  if (inner.split("::").length > 2) {
    return false;
  }
  return inner
    .split(":")
    .every((group) => group === "" || /^[0-9A-Fa-f]{1,4}$/.test(group) || isIpv4(group));
}

/**
 * Validate a bare proxy host.
 *
 * A URL is rejected rather than parsed: the host goes straight into a SOCKS5
 * domain field or an HTTP `CONNECT` request line, so `://`, `/`, `@`, CR, LF, and
 * NUL must be impossible by construction — not stripped later. The rejected
 * value is never interpolated into the error, since an operator may have pasted a
 * credential into it.
 */
export function parseProxyHost(host: unknown): string {
  if (typeof host !== "string") {
    throw new ProxyError("invalid_proxy_config", "host-type");
  }
  const trimmed = host.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HOST_LENGTH) {
    throw new ProxyError("invalid_proxy_config", "host-length");
  }
  if (/[\s/\\@?#%\u0000-\u001f\u007f]/.test(trimmed) || trimmed.includes(":")) {
    // `:` is only legal inside the bracketed IPv6 form, handled below.
    if (!isBracketedIpv6(trimmed)) {
      throw new ProxyError("invalid_proxy_config", "host-shape");
    }
    return trimmed;
  }
  if (isIpv4(trimmed)) {
    return trimmed;
  }
  const labels = trimmed.split(".");
  if (labels.some((label) => !LABEL_RE.test(label))) {
    throw new ProxyError("invalid_proxy_config", "host-label");
  }
  return trimmed.toLowerCase();
}

export function parseProxyPort(port: unknown, stage = "port"): number {
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new ProxyError("invalid_proxy_config", stage);
  }
  return port;
}

export function parseProxyEndpoint(input: {
  host: unknown;
  port: unknown;
}): ProxyEndpoint {
  return {
    host: parseProxyHost(input.host),
    port: parseProxyPort(input.port),
  };
}
