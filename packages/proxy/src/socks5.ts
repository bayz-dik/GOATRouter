import { isIP } from "node:net";
import type { Socket } from "node:net";
import { parseProxyHost, parseProxyPort } from "./endpoint.js";
import { ProxyError, type ProxyErrorCode } from "./errors.js";
import { HandshakeReader } from "./handshake-reader.js";

const VERSION = 0x05;
const METHOD_NONE = 0x00;
const METHOD_USERPASS = 0x02;
const METHOD_NONE_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const USERPASS_VERSION = 0x01;
const MAX_FIELD_BYTES = 255;

export type Socks5Target = {
  host: string;
  port: number;
};

export type Socks5ConnectOptions = {
  socket: Socket;
  target: Socks5Target;
  username?: string;
  password?: string;
  timeoutMs?: number;
};

/** RFC 1928 §6 reply codes, mapped to caller-independent Bayz codes. */
function mapReply(reply: number): ProxyErrorCode | undefined {
  switch (reply) {
    case 0x00:
      return undefined;
    case 0x01:
      return "proxy_error";
    case 0x02:
      return "forbidden";
    case 0x03:
    case 0x04:
      return "unreachable";
    case 0x05:
      return "refused";
    case 0x06:
      return "timeout";
    case 0x07:
    case 0x08:
      return "unsupported_operation";
    default:
      return "protocol_error";
  }
}

function encodeIpv6(host: string): Buffer {
  const inner = host.slice(1, -1);
  const groups = inner.split("::");
  const head = groups[0] === "" ? [] : groups[0]!.split(":");
  const tail = groups.length > 1 ? (groups[1] === "" ? [] : groups[1]!.split(":")) : undefined;

  const words: number[] =
    tail === undefined
      ? head.map((group) => Number.parseInt(group, 16))
      : [
          ...head.map((group) => Number.parseInt(group, 16)),
          ...Array.from({ length: 8 - head.length - tail.length }, () => 0),
          ...tail.map((group) => Number.parseInt(group, 16)),
        ];

  if (words.length !== 8 || words.some((word) => !Number.isInteger(word))) {
    throw new ProxyError("invalid_proxy_config", "target-ipv6");
  }
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}

/** Encode the destination per RFC 1928 §4, choosing ATYP from the host shape. */
function encodeTarget(target: Socks5Target): Buffer {
  const host = parseProxyHost(target.host);
  const port = parseProxyPort(target.port, "target-port");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port, 0);

  if (isIP(host) === 4) {
    return Buffer.concat([
      Buffer.from([ATYP_IPV4]),
      Buffer.from(host.split(".").map(Number)),
      portBytes,
    ]);
  }
  if (host.startsWith("[")) {
    return Buffer.concat([Buffer.from([ATYP_IPV6]), encodeIpv6(host), portBytes]);
  }

  const domain = Buffer.from(host, "utf8");
  if (domain.byteLength > MAX_FIELD_BYTES) {
    // The domain field is length-prefixed with a single byte, so this is a
    // protocol limit rather than a policy choice.
    throw new ProxyError("invalid_proxy_config", "target-host-length");
  }
  return Buffer.concat([
    Buffer.from([ATYP_DOMAIN, domain.byteLength]),
    domain,
    portBytes,
  ]);
}

function write(socket: Socket, payload: Buffer): void {
  socket.write(payload);
}

/**
 * Perform a SOCKS5 `CONNECT` handshake over an already-connected socket.
 *
 * Returns the same socket, positioned at the first payload byte. On any failure a
 * fixed-code `ProxyError` is thrown and no partial state is reported as success.
 */
export async function socks5Connect(
  options: Socks5ConnectOptions,
): Promise<Socket> {
  const { socket, target, username, password, timeoutMs = 10000 } = options;

  // Validated before a single byte goes out, so a bad target never reaches the
  // wire and a caller cannot learn anything from the proxy about it.
  const encodedTarget = encodeTarget(target);

  const useAuth = username !== undefined;
  if (useAuth) {
    if (typeof password !== "string" || password.length === 0) {
      throw new ProxyError("password_missing", "socks5-userpass");
    }
    if (
      Buffer.byteLength(username, "utf8") > MAX_FIELD_BYTES ||
      Buffer.byteLength(password, "utf8") > MAX_FIELD_BYTES ||
      username.length === 0
    ) {
      throw new ProxyError("invalid_proxy_config", "socks5-credential-length");
    }
  }

  const deadline = Date.now() + timeoutMs;
  const reader = new HandshakeReader(socket);

  try {
    const methods = useAuth ? [METHOD_NONE, METHOD_USERPASS] : [METHOD_NONE];
    write(socket, Buffer.from([VERSION, methods.length, ...methods]));

    const greeting = await reader.readExactly(2, deadline);
    if (greeting[0] !== VERSION) {
      throw new ProxyError("protocol_error", "socks5-version");
    }
    const method = greeting[1]!;
    if (method === METHOD_NONE_ACCEPTABLE) {
      throw new ProxyError("auth_failed", "socks5-no-method");
    }
    if (!methods.includes(method)) {
      // Accepting a method we never offered would mean speaking a protocol we
      // did not agree to.
      throw new ProxyError("protocol_error", "socks5-method");
    }

    if (method === METHOD_USERPASS) {
      const user = Buffer.from(username!, "utf8");
      const pass = Buffer.from(password!, "utf8");
      write(
        socket,
        Buffer.concat([
          Buffer.from([USERPASS_VERSION, user.byteLength]),
          user,
          Buffer.from([pass.byteLength]),
          pass,
        ]),
      );
      const authReply = await reader.readExactly(2, deadline);
      if (authReply[0] !== USERPASS_VERSION) {
        throw new ProxyError("protocol_error", "socks5-userpass-version");
      }
      if (authReply[1] !== 0x00) {
        throw new ProxyError("auth_failed", "socks5-userpass-status");
      }
    }

    write(
      socket,
      Buffer.concat([Buffer.from([VERSION, CMD_CONNECT, 0x00]), encodedTarget]),
    );

    const head = await reader.readExactly(4, deadline);
    if (head[0] !== VERSION) {
      throw new ProxyError("protocol_error", "socks5-reply-version");
    }
    const failure = mapReply(head[1]!);
    if (failure !== undefined) {
      throw new ProxyError(failure, "socks5-connect");
    }

    // The bound address must be consumed exactly, or its bytes would be
    // delivered to the caller as if they were payload.
    const atyp = head[3];
    if (atyp === ATYP_IPV4) {
      await reader.readExactly(4 + 2, deadline);
    } else if (atyp === ATYP_IPV6) {
      await reader.readExactly(16 + 2, deadline);
    } else if (atyp === ATYP_DOMAIN) {
      const lengthByte = await reader.readExactly(1, deadline);
      await reader.readExactly(lengthByte[0]! + 2, deadline);
    } else {
      throw new ProxyError("protocol_error", "socks5-reply-atyp");
    }

    reader.release();
    return socket;
  } catch (error) {
    reader.release();
    throw error instanceof ProxyError
      ? error
      : new ProxyError("protocol_error", "socks5-handshake");
  }
}
