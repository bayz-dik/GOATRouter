import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  ProxyError,
  clearLocalListeners,
  dialThroughProxy,
  localListenerCount,
  parseProxyConfig,
  registerLocalListener,
  type ConnectFn,
  type DialProxy,
} from "../src/index.js";

/**
 * Proxy pivot refusal.
 *
 * A proxy is operator-supplied and its *target* comes from a provider base URL, so a
 * proxy asked to open a tunnel back to BAYZ's own listener would make the router a
 * relay into itself: an authenticated request loops, each hop consuming a socket and an
 * outbound permit, until the process exhausts one or the other. The 9F Task 8
 * concurrency cap makes that a bounded failure rather than an unbounded one — which is
 * exactly why the loop must be refused outright rather than merely throttled.
 *
 * Every case asserts the refusal happens **before** `connect` is called. A check that
 * ran after the socket opened would still have handed a hostile configuration one live
 * connection per attempt.
 */

const PROXY: DialProxy = {
  kind: "http",
  host: "127.0.0.1",
  port: 45999,
  username: undefined,
  config: parseProxyConfig({}),
};

/**
 * A connect that records attempts and then fails the socket asynchronously.
 *
 * Deliberately *not* a synchronous throw: `openSocket` reports a connect failure as
 * `ProxyError("refused")` by listening for the socket's `error` event, so a stub that
 * threw inline would escape as a raw `Error` and the test could no longer tell "the
 * pivot check refused this" from "the fake blew up". The distinction is the whole
 * assertion in the narrow-refusal cases.
 */
function countingConnect(): { fn: ConnectFn; attempts: () => number } {
  let attempts = 0;
  const fn = ((): unknown => {
    attempts += 1;
    const socket = new EventEmitter() as EventEmitter & { destroy: () => void };
    socket.destroy = () => {};
    setImmediate(() => socket.emit("error", new Error("refused by the test")));
    return socket;
  }) as unknown as ConnectFn;
  return { fn, attempts: () => attempts };
}

test("a proxy tunnel to the Bayz listener itself is refused before any socket opens", async (t) => {
  clearLocalListeners();
  t.after(() => clearLocalListeners());
  registerLocalListener({ host: "127.0.0.1", port: 20128 });

  const connect = countingConnect();

  await assert.rejects(
    () =>
      dialThroughProxy({
        proxy: PROXY,
        target: { host: "127.0.0.1", port: 20128 },
        connect: connect.fn,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProxyError);
      assert.equal(error.code, "forbidden");
      assert.equal(error.stage, "dial-self-pivot");
      // The message names no host and no port: the value is operator configuration
      // and the error reaches logs.
      assert.equal(error.message.includes("20128"), false);
      assert.equal(error.message.includes("127.0.0.1"), false);
      return true;
    },
  );
  assert.equal(connect.attempts(), 0, "the refusal must precede the connect");
});

test("every loopback spelling of the listener is refused, not just the registered one", async (t) => {
  clearLocalListeners();
  t.after(() => clearLocalListeners());
  registerLocalListener({ host: "127.0.0.1", port: 20128 });

  // A pivot attempt will not politely reuse the registered spelling. All of these
  // reach the same listener, so all must be refused.
  for (const host of [
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "127.0.0.53",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ]) {
    const connect = countingConnect();
    await assert.rejects(
      () =>
        dialThroughProxy({
          proxy: PROXY,
          target: { host, port: 20128 },
          connect: connect.fn,
        }),
      (error: unknown) => error instanceof ProxyError && error.stage === "dial-self-pivot",
      `${host} was not recognised as the local listener`,
    );
    assert.equal(connect.attempts(), 0, `${host} opened a socket`);
  }
});

test("a numeric-obfuscated loopback target is refused too", async (t) => {
  clearLocalListeners();
  t.after(() => clearLocalListeners());
  registerLocalListener({ host: "127.0.0.1", port: 20128 });

  // `2130706433`, `127.1`, `0x7f000001`, and `0177.0.0.1` all reach 127.0.0.1. A
  // check that only understood dotted quads would wave every one of them through —
  // this is the same bypass class the provider egress filter was built against.
  for (const host of ["2130706433", "127.1", "0x7f000001", "0177.0.0.1"]) {
    const connect = countingConnect();
    await assert.rejects(
      () =>
        dialThroughProxy({
          proxy: PROXY,
          target: { host, port: 20128 },
          connect: connect.fn,
        }),
      (error: unknown) => error instanceof ProxyError && error.stage === "dial-self-pivot",
      `${host} was not recognised as loopback`,
    );
    assert.equal(connect.attempts(), 0, `${host} opened a socket`);
  }
});

test("a wildcard listener claims every local address on its port", async (t) => {
  clearLocalListeners();
  t.after(() => clearLocalListeners());
  // `0.0.0.0` binds every interface the host has, so a tunnel to any local address on
  // that port reaches BAYZ. Treating the wildcard as literally the address "0.0.0.0"
  // would leave every actual interface address open.
  registerLocalListener({ host: "0.0.0.0", port: 20128 });

  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    await assert.rejects(
      () =>
        dialThroughProxy({
          proxy: PROXY,
          target: { host, port: 20128 },
          connect: countingConnect().fn,
        }),
      (error: unknown) => error instanceof ProxyError && error.stage === "dial-self-pivot",
      `${host} was permitted against a wildcard listener`,
    );
  }
});

test("the refusal is narrow: another port and another host still dial", async (t) => {
  clearLocalListeners();
  t.after(() => clearLocalListeners());
  registerLocalListener({ host: "127.0.0.1", port: 20128 });

  // A local model runtime on another port is a first-class use case, and refusing it
  // would break exactly what the loopback egress opt-in exists to allow.
  const connect = countingConnect();
  for (const target of [
    { host: "127.0.0.1", port: 11434 },
    { host: "api.example.com", port: 443 },
  ]) {
    await assert.rejects(
      () => dialThroughProxy({ proxy: PROXY, target, connect: connect.fn }),
      (error: unknown) => error instanceof ProxyError && error.stage !== "dial-self-pivot",
      `${target.host}:${target.port} was wrongly treated as a pivot`,
    );
  }
  assert.equal(connect.attempts(), 2, "a permitted target must reach the connect");
});

test("a non-loopback listener address is matched exactly, not by class", async (t) => {
  clearLocalListeners();
  t.after(() => clearLocalListeners());
  // A `lan` deployment binds a specific private address. That address on that port is
  // BAYZ; a *different* private address is somebody else's machine and is a legitimate
  // target, so the match must be on the address rather than on "is private".
  registerLocalListener({ host: "192.168.1.10", port: 20128 });

  await assert.rejects(
    () =>
      dialThroughProxy({
        proxy: PROXY,
        target: { host: "192.168.1.10", port: 20128 },
        connect: countingConnect().fn,
      }),
    (error: unknown) => error instanceof ProxyError && error.stage === "dial-self-pivot",
  );

  const connect = countingConnect();
  await assert.rejects(
    () =>
      dialThroughProxy({
        proxy: PROXY,
        target: { host: "192.168.1.11", port: 20128 },
        connect: connect.fn,
      }),
    (error: unknown) => error instanceof ProxyError && error.stage !== "dial-self-pivot",
    "a different LAN host must not be refused as a pivot",
  );
  assert.equal(connect.attempts(), 1);
});

test("with no listener registered nothing is refused as a pivot", async () => {
  clearLocalListeners();
  // Every existing caller — the smoke scripts, a library embedder, the proxy health
  // check — registers no listener and must behave exactly as it did before.
  const connect = countingConnect();
  await assert.rejects(
    () =>
      dialThroughProxy({
        proxy: PROXY,
        target: { host: "127.0.0.1", port: 20128 },
        connect: connect.fn,
      }),
    (error: unknown) => error instanceof ProxyError && error.stage !== "dial-self-pivot",
  );
  assert.equal(connect.attempts(), 1);
});

test("registering the same listener twice does not accumulate state", (t) => {
  clearLocalListeners();
  t.after(() => clearLocalListeners());
  registerLocalListener({ host: "127.0.0.1", port: 20128 });
  registerLocalListener({ host: "127.0.0.1", port: 20128 });
  assert.equal(localListenerCount(), 1);

  registerLocalListener({ host: "127.0.0.1", port: 20129 });
  assert.equal(localListenerCount(), 2);
  clearLocalListeners();
  assert.equal(localListenerCount(), 0);
});

test("an unusable listener registration is refused rather than silently ignored", () => {
  clearLocalListeners();
  // A registration that quietly failed would leave the pivot check believing it was
  // protecting a listener it knows nothing about — worse than not registering at all,
  // because the operator would have no reason to look.
  for (const bad of [
    { host: "", port: 20128 },
    { host: "127.0.0.1", port: 0 },
    { host: "127.0.0.1", port: 70000 },
    { host: "127.0.0.1", port: 1.5 },
  ]) {
    assert.throws(
      () => registerLocalListener(bad),
      (error: unknown) =>
        error instanceof ProxyError && error.code === "invalid_proxy_config",
      `${bad.host}:${bad.port} was accepted`,
    );
  }
  assert.equal(localListenerCount(), 0);
});
