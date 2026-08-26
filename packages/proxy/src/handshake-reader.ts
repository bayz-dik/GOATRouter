import type { Socket } from "node:net";
import { ProxyError } from "./errors.js";

/**
 * Bounded reader over a socket.
 *
 * Every handshake stage asks for the exact number of bytes it needs. Nothing here
 * ever reads "whatever arrived": a proxy is an untrusted peer, so an unparseable
 * prefix must fail immediately, a truncated reply must not hang, and no allocation
 * may be driven by a length the peer has not yet justified.
 *
 * Leftover bytes are pushed back onto the socket with `unshift`, so the caller
 * receives a stream positioned exactly at the first payload byte even when the
 * proxy coalesced its reply and the payload into one TCP segment.
 */
export class HandshakeReader {
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;
  private failure: Error | undefined;
  private waiter: (() => void) | undefined;

  private readonly onData = (chunk: Buffer): void => {
    this.chunks.push(Buffer.from(chunk));
    this.length += chunk.length;
    this.wake();
  };
  private readonly onEnd = (): void => {
    this.ended = true;
    this.wake();
  };
  private readonly onError = (error: Error): void => {
    this.failure = error;
    this.wake();
  };

  constructor(private readonly socket: Socket) {
    socket.on("data", this.onData);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
    socket.on("error", this.onError);
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  /** Read exactly `count` bytes or throw; `deadline` bounds the total wait. */
  async readExactly(count: number, deadline: number): Promise<Buffer> {
    while (this.length < count) {
      if (this.failure !== undefined) {
        throw new ProxyError("protocol_error", "handshake-socket-error");
      }
      if (this.ended) {
        // The peer closed mid-reply: a shorter message than the protocol
        // requires is never "maybe fine".
        throw new ProxyError("protocol_error", "handshake-truncated");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ProxyError("timeout", "handshake-read");
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        const timer = setTimeout(() => {
          if (this.waiter === resolve) {
            this.waiter = undefined;
            resolve();
          }
        }, remaining);
        // The timer must not keep the process alive on its own.
        timer.unref?.();
      });
    }

    const merged = Buffer.concat(this.chunks, this.length);
    const taken = merged.subarray(0, count);
    const rest = merged.subarray(count);
    this.chunks = rest.length > 0 ? [Buffer.from(rest)] : [];
    this.length = rest.length;
    return Buffer.from(taken);
  }

  /** Detach and return any buffered bytes to the socket stream. */
  release(): void {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onError);
    if (this.length > 0) {
      this.socket.unshift(Buffer.concat(this.chunks, this.length));
      this.chunks = [];
      this.length = 0;
    }
  }
}
