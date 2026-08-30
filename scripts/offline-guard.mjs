/**
 * Offline guard — Phase 9K Task 7.
 *
 * A `--import` preload that throws on any outbound connection that would **leave this machine**, so the
 * unit suites can be proven not to depend on the internet. Covers `net.connect`, `tls.connect`,
 * `dns.lookup`, `dns.resolve`, and `fetch`.
 *
 * **Loopback and same-host addresses are deliberately exempt, and that exemption is the guard's one hole.**
 * It is justified rather than convenient. `scripts/api-smoke.mjs`, `scripts/install-smoke.mjs`, and
 * `scripts/upgrade-smoke.mjs` drive a *real* HTTP origin over `127.0.0.1` — that is the whole design of the
 * smoke suites, which exist precisely so BAYZ is tested against real sockets instead of mocks. A guard that
 * blocked loopback would force those tests into mocks, which is a strictly worse outcome than having no
 * guard at all.
 *
 * The same-host half of the exemption exists for a sharper reason: 21 tests in `@bayz/router` and
 * `@bayz/server` bind a test origin to this machine's own LAN address, because `allowLoopback` is exactly
 * what makes the egress classifier return `LOCAL` and a loopback origin therefore cannot exercise the
 * `private` classification the free-only routing evidence depends on. Such traffic is routed internally by
 * the kernel and never reaches a network. See `isOwnHostAddress` in `scripts/offline-loopback.mjs` for the
 * measurement and the bound: membership comes from `os.networkInterfaces()`, so exactly the addresses the
 * kernel calls ours are admitted and nothing else.
 *
 * **This guard is opt-in and must stay that way.** It is never installed via a global `NODE_OPTIONS`,
 * because the install and upgrade smokes legitimately reach the npm registry to install a real tarball.
 * `tests/offline.test.mjs` asserts it is absent from the normal environment.
 *
 * Every refusal names the host it blocked. "Network blocked" with no destination forces whoever hits it
 * to bisect; naming the host makes the failure actionable, which is the difference between a guard people
 * fix tests for and a guard people delete.
 */

import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import {
  isLoopbackHost,
  isOwnHostAddress,
  isSameHostDestination,
} from "./offline-loopback.mjs";

/** Marker the check script reads back to confirm the guard actually loaded. */
process.env.BAYZ_OFFLINE_GUARD = "active";

export { isLoopbackHost, isOwnHostAddress, isSameHostDestination };

class OfflineGuardError extends Error {
  constructor(operation, host) {
    super(`offline guard: ${operation} to off-host address "${host}" is blocked during offline verification`);
    this.name = "OfflineGuardError";
    this.code = "BAYZ_OFFLINE_GUARD";
  }
}

/** `net.connect(port, host)`, `net.connect({host, port})`, and `net.connect(path)` all reach here. */
function hostFromConnectArgs(args) {
  const [first, second] = args;
  if (typeof first === "object" && first !== null) return first.host ?? first.path ?? "";
  if (typeof second === "string") return second;
  return "";
}

const realNetConnect = net.connect.bind(net);
const realNetCreateConnection = net.createConnection.bind(net);
const realTlsConnect = tls.connect.bind(tls);

function guardedConnect(real, operation) {
  return function guarded(...args) {
    const host = hostFromConnectArgs(args);
    if (!isSameHostDestination(host)) throw new OfflineGuardError(operation, host);
    return real(...args);
  };
}

net.connect = guardedConnect(realNetConnect, "net.connect");
net.createConnection = guardedConnect(realNetCreateConnection, "net.createConnection");
tls.connect = guardedConnect(realTlsConnect, "tls.connect");

/*
 * DNS matters independently of connecting: resolving a name already leaks which hosts this project talks
 * to, and a test that resolves is a test that expects to reach something.
 *
 * **`dns.lookup` honours the same-host exemption; `dns.resolve*` does not.** Measured with the resolver
 * pointed at a black hole: `dns.lookup("192.168.100.53")` answers with no query, while
 * `dns.resolve4("192.168.100.53")` times out — `lookup` short-circuits an address literal inside
 * `getaddrinfo`, `resolve*` genuinely queries. `server.listen(0, "<this machine's LAN address>")` goes
 * through `lookup`, and binding a local interface sends nothing anywhere; refusing it made the offline
 * check report 21 router and server tests as network-dependent when none of them were.
 */
const realLookup = dns.lookup.bind(dns);
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (isSameHostDestination(hostname)) return realLookup(hostname, ...rest);
  const callback = rest.find((argument) => typeof argument === "function");
  const error = new OfflineGuardError("dns.lookup", hostname);
  // Report through the callback rather than throwing: that is the contract callers are written against,
  // and throwing here would surface as an unhandled exception instead of a readable test failure.
  if (callback !== undefined) {
    process.nextTick(() => callback(error));
    return undefined;
  }
  throw error;
};

for (const method of ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveMx", "resolveTxt"]) {
  const real = dns[method]?.bind(dns);
  if (typeof real !== "function") continue;
  dns[method] = function guardedResolve(hostname, ...rest) {
    // Loopback only, deliberately: resolving our own LAN address still needs a name server, and needing
    // one is exactly the dependency this guard exists to rule out.
    if (isLoopbackHost(hostname)) return real(hostname, ...rest);
    const callback = rest.find((argument) => typeof argument === "function");
    const error = new OfflineGuardError(`dns.${method}`, hostname);
    if (callback !== undefined) {
      process.nextTick(() => callback(error));
      return undefined;
    }
    throw error;
  };
}

if (typeof dns.promises === "object" && dns.promises !== null) {
  const realPromisesLookup = dns.promises.lookup.bind(dns.promises);
  dns.promises.lookup = async function guardedPromisesLookup(hostname, ...rest) {
    // Same exemption as the callback form above, for the same measured reason.
    if (!isSameHostDestination(hostname)) {
      throw new OfflineGuardError("dns.promises.lookup", hostname);
    }
    return realPromisesLookup(hostname, ...rest);
  };
}

/*
 * `fetch` is the one most likely to hide in a test, since it needs no import at all.
 */
const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  globalThis.fetch = async function guardedFetch(resource, options) {
    let host = "";
    try {
      host = new URL(typeof resource === "string" ? resource : (resource?.url ?? String(resource))).hostname;
    } catch {
      host = String(resource);
    }
    if (!isSameHostDestination(host)) throw new OfflineGuardError("fetch", host);
    return realFetch(resource, options);
  };
}
