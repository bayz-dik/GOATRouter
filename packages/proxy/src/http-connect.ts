import type { Socket } from "node:net";
import { parseProxyHost, parseProxyPort } from "./endpoint.js";
import { ProxyError, type ProxyErrorCode } from "./errors.js";
import { HandshakeReader } from "./handshake-reader.js";

/** A response header block larger than this is treated as hostile, not verbose. */
const MAX_HEADER_BYTES = 16 * 1024;
const STATUS_LINE_RE = /^HTTP\/1\.[01] (\d{3})(?: |$)/;

export type HttpConnectTarget = {
  host: string;
  port: number;
};

export type HttpConnectOptions = {
  socket: Socket;
  target: HttpConnectTarget;
  username?: string;
  password?: string;
  timeoutMs?: number;
};

function mapStatus(status: number): ProxyErrorCode | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 401 || status === 407) {
    return "auth_failed";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 502 || status === 504) {
    return "unreachable";
  }
  return "proxy_error";
}

/**
 * Establish an HTTP `CONNECT` tunnel over an already-connected socket.
 *
 * Returns the same socket, positioned at the first tunneled byte. The target is
 * validated before the request line is built, so CRLF injection into the request
 * is impossible by construction rather than escaped after the fact.
 */
export async function httpConnect(options: HttpConnectOptions): Promise<Socket> {
  const { socket, target, username, password, timeoutMs = 10000 } = options;

  const host = parseProxyHost(target.host);
  const port = parseProxyPort(target.port, "target-port");
  const authority = `${host}:${port}`;

  const headers = [`CONNECT ${authority} HTTP/1.1`, `host: ${authority}`];
  if (username !== undefined) {
    if (typeof password !== "string" || password.length === 0) {
      throw new ProxyError("password_missing", "http-connect-userpass");
    }
    if (/[\u0000-\u001f\u007f]/.test(username) || /[\u0000-\u001f\u007f]/.test(password)) {
      // Control characters would split the header block.
      throw new ProxyError("invalid_proxy_config", "http-connect-credential");
    }
    const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    headers.push(`proxy-authorization: Basic ${encoded}`);
  }

  const deadline = Date.now() + timeoutMs;
  const reader = new HandshakeReader(socket);

  try {
    socket.write(`${headers.join("\r\n")}\r\n\r\n`);

    // Read byte-by-byte until the terminator so the tunneled payload is never
    // consumed, with a hard cap so a proxy cannot stream headers forever.
    let block = Buffer.alloc(0);
    for (;;) {
      const next = await reader.readExactly(1, deadline);
      block = Buffer.concat([block, next]);
      if (block.length >= 4 && block.subarray(block.length - 4).toString("latin1") === "\r\n\r\n") {
        break;
      }
      if (block.length > MAX_HEADER_BYTES) {
        throw new ProxyError("protocol_error", "http-connect-headers-too-large");
      }
    }

    const statusLine = block.subarray(0, block.indexOf("\r\n")).toString("latin1");
    const match = STATUS_LINE_RE.exec(statusLine);
    if (match === null) {
      throw new ProxyError("protocol_error", "http-connect-status-line");
    }
    const failure = mapStatus(Number(match[1]));
    if (failure !== undefined) {
      // The response body and headers are discarded: a proxy error page may echo
      // the credential that was just rejected.
      throw new ProxyError(failure, `http-connect-status-${match[1]}`);
    }

    reader.release();
    return socket;
  } catch (error) {
    reader.release();
    throw error instanceof ProxyError
      ? error
      : new ProxyError("protocol_error", "http-connect");
  }
}
