/**
 * Loopback and same-host destination classification — Phase 9K Task 7.
 *
 * **Deliberately a separate module with no side effects.** `scripts/offline-guard.mjs` is a preload: merely
 * importing it patches `net`, `tls`, `dns`, and `fetch` in the importing process and sets the
 * `BAYZ_OFFLINE_GUARD` marker. That is correct for a preload and wrong for a unit test — importing the
 * guard to unit-test its predicate silently armed the guard inside the test process, which made three
 * tests in `tests/offline.test.mjs` skip themselves on every ordinary run while still reporting green.
 *
 * Splitting the predicates out means the classification rules can be tested directly without arming
 * anything.
 */

import { networkInterfaces } from "node:os";

/**
 * Is `host` a loopback destination?
 *
 * `0.0.0.0` counts: a server binding it is local, and the smokes use it when asserting that a non-loopback
 * bind is refused. The whole of `127.0.0.0/8` counts, not merely `127.0.0.1`. An empty host means a unix
 * socket or an existing file descriptor, which is not a network destination at all.
 */
export function isLoopbackHost(host) {
  if (typeof host !== "string" || host === "") return true;
  const bare = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (bare === "::1" || bare === "::" || bare === "0.0.0.0") return true;
  if (/^127\./.test(bare)) return true;
  if (bare === "::ffff:127.0.0.1") return true;
  return false;
}

/**
 * Every address currently assigned to an interface on this machine.
 *
 * Read once and cached: the set does not change during a test run, and re-reading it per socket would put
 * a syscall on every connection the guard inspects.
 */
let ownAddresses;
function ownHostAddresses() {
  if (ownAddresses === undefined) {
    ownAddresses = new Set();
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        // `%scope` suffixes appear on link-local IPv6; the comparison below is on the bare address.
        ownAddresses.add(String(entry.address).toLowerCase().split("%")[0]);
      }
    }
  }
  return ownAddresses;
}

/**
 * Is `host` an address belonging to **this machine**?
 *
 * **This is the guard's second exemption, and it is narrower and more defensible than it first looks.**
 * Traffic to an address assigned to a local interface never leaves the host — the kernel routes it
 * internally, exactly as it does for `127.0.0.1`. It is loopback in every sense that matters to the claim
 * this guard exists to support, which is *no unit test depends on the internet*.
 *
 * Why it is needed: 21 tests across `@bayz/router` and `@bayz/server` bind a test origin to this machine's
 * private LAN address and then drive real HTTP against it. They cannot use `127.0.0.1`, and the reason is
 * load-bearing rather than incidental — `allowLoopback` is precisely what makes the egress classifier
 * return `LOCAL`, so a loopback origin can never exercise the `private` classification path that free-only
 * routing evidence rests on. Blocking them made `scripts/offline-check.mjs` report a network dependency
 * that does not exist, and the only alternatives were to weaken those tests into mocks or to accept a
 * permanently red offline check. Both are worse than stating this exemption and bounding it.
 *
 * How it is bounded: membership is decided against `os.networkInterfaces()`, so it admits exactly the
 * addresses the kernel says are ours and nothing else. A real internet destination is not in that set, and
 * a test that reaches for one is still refused by name.
 *
 * What it does **not** exempt: `dns.resolve*`. Measured with the resolver pointed at a black hole,
 * `dns.lookup("192.168.100.53")` answers with no query while `dns.resolve4("192.168.100.53")` times out —
 * `lookup` short-circuits literals inside `getaddrinfo`, `resolve*` genuinely queries. So `resolve*` stays
 * keyed on loopback alone: resolving our own address still needs a name server, and needing one is the
 * thing being ruled out.
 */
export function isOwnHostAddress(host) {
  if (typeof host !== "string" || host === "") return false;
  const bare = host.replace(/^\[/, "").replace(/\]$/, "").trim().toLowerCase().split("%")[0];
  if (bare === "") return false;
  return ownHostAddresses().has(bare);
}

/**
 * Is `host` a destination that cannot leave this machine?
 *
 * The predicate the guard's connect, TLS, and `fetch` hooks use. Named for the property it asserts —
 * "this traffic stays here" — rather than for the two rules that implement it.
 */
export function isSameHostDestination(host) {
  return isLoopbackHost(host) || isOwnHostAddress(host);
}
