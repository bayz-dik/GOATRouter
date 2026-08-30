import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isLoopbackHost,
  isOwnHostAddress,
  isSameHostDestination,
} from "../scripts/offline-loopback.mjs";
import { DEPTH_VARIABLE, isInsideOfflineCheck } from "../scripts/offline-nesting.mjs";

/**
 * Offline test proof — Phase 9K Task 7.
 *
 * The claim being established: **no unit test secretly depends on the internet.** A suite that quietly
 * reaches a network is a suite that fails in someone else's CI, behaves differently offline, and — worst
 * — may be passing because a remote service answered rather than because the code is right.
 *
 * The mechanism is a `--import` preload (`scripts/offline-guard.mjs`) that throws on any outbound
 * connection that would leave this machine: `net.connect`, `tls.connect`, `dns.lookup`, `dns.resolve`, and
 * `fetch`. Loopback stays permitted, because the smoke suites deliberately drive a real origin over
 * `127.0.0.1` and blocking that would be blocking the point. This machine's **own** addresses are
 * permitted too, for a narrower reason asserted below.
 *
 * The load-bearing test here is the **positive control**: a deliberate `fetch("https://example.invalid")`
 * inside the harness must be caught. Without it, a guard that silently did nothing would produce a
 * green offline run and a completely false conclusion — the exact failure mode that makes a security
 * control worse than none, because it reads as proof.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(ROOT, "scripts/offline-guard.mjs");
const CHECK = join(ROOT, "scripts/offline-check.mjs");

/** This machine's first non-internal IPv4 address, or `undefined` on a host that has none. */
const OWN_LAN_ADDRESS = (() => {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
})();

/**
 * Are we already running inside `scripts/offline-check.mjs`?
 *
 * Two independent markers, and both are needed. `BAYZ_OFFLINE_GUARD` is set by the preload, so it is
 * absent on the check's own `--simulate-no-guard` path — a break keyed only on it lets that path spawn
 * another level. `BAYZ_OFFLINE_CHECK_DEPTH` is set by the check itself on every path, guarded or not.
 *
 * Each level of nesting spawns *two* children (the run test and the refusal test), so the growth is 2^n.
 *
 * **The predicate itself lives in `scripts/offline-nesting.mjs`, deliberately.** It used to be a local
 * copy of the check's own logic, and two hand-maintained copies of a fork-bomb break is one copy too
 * many — they can drift, and neither could be exercised without building the process tree they exist to
 * prevent. Sharing the module means `tests/offline-recursion.test.mjs` can assert both halves of the break
 * in-process, with no children at all.
 */
function insideOfflineCheck() {
  return isInsideOfflineCheck(process.env);
}

/**
 * Run a snippet with the guard preloaded, returning status and combined output.
 *
 * **Bounded, and the bound is load-bearing.** Two of these probes deliberately attempt a connection to a
 * public address expecting the guard to refuse it. If the guard is broken — which is exactly the state a
 * mutation test creates — the connection is attempted for real and the probe hangs on a TCP handshake to
 * an unreachable internet host until the OS gives up, which is minutes. Measured: without a timeout, the
 * `net.connect` and `tls.connect` probes hang indefinitely under a mutation that disables the guard, and
 * the whole file dies at its ceiling with no output and therefore no named failure.
 *
 * A timeout converts that into a normal, attributable red: `execFileSync` kills the child and this
 * returns its partial output, so the assertion below fails on the missing `BLOCKED` line and names
 * itself. 20 s is far above any legitimate probe here (the slowest is ~1 s) and far below a kernel
 * connect timeout.
 */
function underGuard(source) {
  const dir = mkdtempSync(join(tmpdir(), "bayz-offline-"));
  const file = join(dir, "probe.mjs");
  writeFileSync(file, source);
  try {
    const output = execFileSync(process.execPath, ["--import", GUARD, file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    return { status: 0, output };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      // Surfaced so an assertion can say "the probe never answered" rather than "output did not match",
      // which are different diagnoses of a broken guard.
      timedOut: error.killed === true || error.signal === "SIGKILL",
    };
  }
}

test("the guard blocks fetch to an off-host address", () => {
  /*
   * The positive control the plan requires. `example.invalid` is reserved by RFC 2606 and can never
   * resolve, so this asserts the *guard* fired rather than that DNS failed — the error message must name
   * the guard.
   */
  const result = underGuard(`
    try {
      await fetch("https://example.invalid/");
      console.log("NOT BLOCKED");
    } catch (error) {
      console.log("BLOCKED:", error.message);
    }
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /BLOCKED: .*offline guard/i, result.output);
  assert.ok(!/NOT BLOCKED/.test(result.output), "fetch to an off-host address was permitted");
});

test("the guard blocks net.connect to an off-host address", () => {
  /*
   * `net.connect` returns a socket rather than throwing on failure, so the refusal must be synchronous
   * for this to be a real check — and it is: the guard classifies before calling through. The socket is
   * destroyed either way, because a probe that leaves a pending connection open would hold the process
   * alive past its own conclusion.
   */
  const result = underGuard(`
    import net from "node:net";
    try {
      const socket = net.connect({ host: "93.184.216.34", port: 80 });
      socket.destroy();
      console.log("NOT BLOCKED");
    } catch (error) {
      console.log("BLOCKED:", error.message);
    }
  `);
  assert.ok(!result.timedOut, `the probe never answered, so the guard did not refuse synchronously:\n${result.output}`);
  assert.match(result.output, /BLOCKED: .*offline guard/i, result.output);
  assert.ok(!/NOT BLOCKED/.test(result.output), "net.connect to an off-host address was permitted");
});

test("the guard blocks tls.connect to an off-host address", () => {
  const result = underGuard(`
    import tls from "node:tls";
    try {
      const socket = tls.connect({ host: "93.184.216.34", port: 443 });
      socket.destroy();
      console.log("NOT BLOCKED");
    } catch (error) {
      console.log("BLOCKED:", error.message);
    }
  `);
  assert.ok(!result.timedOut, `the probe never answered, so the guard did not refuse synchronously:\n${result.output}`);
  assert.match(result.output, /BLOCKED: .*offline guard/i, result.output);
  assert.ok(!/NOT BLOCKED/.test(result.output), "tls.connect to an off-host address was permitted");
});

test("the guard blocks dns.lookup for an off-host name", () => {
  /*
   * DNS matters on its own: a test that resolves a name is already leaking which hosts this project
   * talks to, even if the connection then fails.
   */
  const result = underGuard(`
    import dns from "node:dns";
    dns.lookup("registry.npmjs.org", (error) => {
      console.log(error ? "BLOCKED: " + error.message : "NOT BLOCKED");
    });
  `);
  assert.match(result.output, /BLOCKED: .*offline guard/i, result.output);
});

test("loopback traffic is permitted, because the smokes depend on it", () => {
  /*
   * The counter-case that keeps the guard usable. `scripts/api-smoke.mjs` and friends drive a real
   * origin over 127.0.0.1; a guard that blocked loopback would force those tests into mocks, which is a
   * strictly worse outcome than not having the guard.
   */
  const result = underGuard(`
    import net from "node:net";
    const server = net.createServer((socket) => socket.end("ok"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => { socket.end(); resolve(); });
      socket.on("error", reject);
    });
    server.close();
    console.log("LOOPBACK OK");
  `);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /LOOPBACK OK/, result.output);
});

test("localhost and ::1 count as loopback", () => {
  // Unit-level, so the host classification is pinned independently of what the suites happen to use.
  for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "127.1.2.3", "0.0.0.0"]) {
    assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
  }
  for (const host of ["93.184.216.34", "registry.npmjs.org", "example.invalid", "10.0.0.5", "8.8.8.8"]) {
    assert.equal(isLoopbackHost(host), false, `${host} should not be loopback`);
  }
});

test("this machine's own addresses are same-host, and nothing else is", (t) => {
  /*
   * **The second exemption, asserted in both directions.**
   *
   * `isOwnHostAddress` is what lets 21 router and server tests bind a test origin to this machine's LAN
   * address. Those tests cannot use loopback: `allowLoopback` is exactly what makes the egress classifier
   * return `LOCAL`, so a loopback origin can never exercise the `private` classification that free-only
   * routing evidence rests on. Traffic to a local interface never leaves the host, so permitting it does
   * not weaken the claim — but an exemption keyed on "looks like a private address" **would**, since
   * `10.0.0.5` on someone else's LAN is a real network destination.
   *
   * So the rule is membership in `os.networkInterfaces()`, and this test pins both halves: our own address
   * is admitted, and a private-looking address that is *not* ours is refused.
   */
  if (OWN_LAN_ADDRESS === undefined) {
    t.skip("this host has no non-internal IPv4 interface, so there is no own-address case to assert");
    return;
  }

  assert.equal(isOwnHostAddress(OWN_LAN_ADDRESS), true, `${OWN_LAN_ADDRESS} is this machine's own address`);
  assert.equal(isSameHostDestination(OWN_LAN_ADDRESS), true);
  assert.equal(isLoopbackHost(OWN_LAN_ADDRESS), false, "the own-address rule must be separate from loopback");

  // Private ranges are NOT exempt as a class — only addresses this machine actually holds.
  for (const host of ["10.255.255.254", "192.168.255.254", "172.31.255.254"]) {
    if (host === OWN_LAN_ADDRESS) continue;
    assert.equal(isOwnHostAddress(host), false, `${host} is not this machine's address and must not be exempt`);
    assert.equal(isSameHostDestination(host), false, `${host} must not be treated as same-host`);
  }
  for (const host of ["93.184.216.34", "registry.npmjs.org", "example.invalid", "8.8.8.8"]) {
    assert.equal(isSameHostDestination(host), false, `${host} must not be treated as same-host`);
  }
});

test("the guard permits a bind to this machine's own address, and still blocks reaching out", (t) => {
  /*
   * The exemption end-to-end, under the real preload, with the refusal it must not have loosened asserted
   * in the same process. `server.listen(0, "<own address>")` goes through `dns.lookup`, which is where the
   * guard used to refuse it and report 21 tests as network-dependent when none of them were.
   */
  if (OWN_LAN_ADDRESS === undefined) {
    t.skip("this host has no non-internal IPv4 interface to bind");
    return;
  }

  const result = underGuard(`
    import net from "node:net";
    const server = net.createServer((socket) => socket.end("ok"));
    await new Promise((resolve, reject) => {
      server.on("error", reject);
      server.listen(0, ${JSON.stringify(OWN_LAN_ADDRESS)}, resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: ${JSON.stringify(OWN_LAN_ADDRESS)}, port }, () => { socket.end(); resolve(); });
      socket.on("error", reject);
    });
    server.close();
    console.log("OWN ADDRESS OK");

    // The same process must still refuse a real destination, so this exemption cannot be read as
    // "the guard is off when the machine has a LAN address".
    try {
      await fetch("https://registry.npmjs.org/fastify");
      console.log("STILL REACHABLE");
    } catch (error) {
      console.log("STILL BLOCKED:", error.code);
    }
  `);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /OWN ADDRESS OK/, result.output);
  assert.match(result.output, /STILL BLOCKED: BAYZ_OFFLINE_GUARD/, result.output);
  assert.ok(!/STILL REACHABLE/.test(result.output), "the own-address exemption disabled the guard entirely");
});

test("resolving a name is refused even when it is this machine's own address", (t) => {
  /*
   * **The asymmetry that keeps the own-address exemption honest, and the reason it is asserted against
   * *our own* address rather than an arbitrary private one.**
   *
   * Measured: `dns.lookup("192.168.100.53")` answers with no query at all — the literal short-circuits
   * inside `getaddrinfo` — while `dns.resolve4` of the same literal times out against an unreachable
   * resolver, because it really does send a query. Resolving therefore needs a name server, needing one
   * is exactly the dependency this guard exists to rule out, and so `dns.resolve*` stays keyed on
   * loopback alone while `dns.lookup` honours the exemption.
   *
   * The address has to be one this machine actually holds. An earlier version of this test used
   * `192.168.1.1`, which is not ours: `isSameHostDestination` returns false for it either way, so the
   * refusal held whether or not `dns.resolve*` had been given the exemption. The test passed while
   * proving nothing — a mutation granting `resolve*` the own-address exemption (K25c) survived it. Using
   * an address the exemption would actually admit is what makes the assertion load-bearing.
   */
  if (OWN_LAN_ADDRESS === undefined) {
    t.skip("this host has no non-internal IPv4 interface, so the exemption has no address to admit");
    return;
  }

  const result = underGuard(`
    import dns from "node:dns";
    dns.resolve4(${JSON.stringify(OWN_LAN_ADDRESS)}, (error) => {
      console.log(error ? "RESOLVE REFUSED: " + error.code : "RESOLVE ALLOWED");
    });
  `);

  assert.ok(
    !result.timedOut,
    `the probe never answered — dns.resolve4 was permitted and went to a real resolver:\n${result.output}`,
  );
  assert.match(
    result.output,
    /RESOLVE REFUSED: BAYZ_OFFLINE_GUARD/,
    `dns.resolve4 of this machine's own address was not refused by the guard:\n${result.output}`,
  );
  assert.ok(!/RESOLVE ALLOWED/.test(result.output), "dns.resolve* inherited the own-address exemption");
});

test("the guard names the host it blocked, so a failure is actionable", () => {
  /*
   * "Network blocked" with no host is a bad error: whoever hits it has to bisect to find out what
   * reached out. The message must identify the destination.
   */
  const result = underGuard(`
    try {
      await fetch("https://registry.npmjs.org/fastify");
    } catch (error) {
      console.log("MESSAGE:", error.message);
    }
  `);
  assert.match(result.output, /registry\.npmjs\.org/, `the error does not name the host:\n${result.output}`);
});

test("the offline check runs the unit suites and exits 0", (t) => {
  /*
   * The real claim, and the expensive one. This drives `scripts/offline-check.mjs`, which runs the unit
   * suites with the guard preloaded. It is bounded deliberately: the workspace suites are run one at a
   * time, since fanning out exhausts the futex table on this device.
   *
   * **The count assertion is load-bearing, not decoration.** The first version of this test passed while
   * the nested suite ran *zero tests*: `node --test` exports `NODE_TEST_CONTEXT`, the nested run inherited
   * it, decided it was already a test worker, and reported success in 0s with no counts. A green
   * "offline check: PASS" over an empty run is exactly the vacuous result this task exists to rule out.
   * Requiring a three-digit pass count is what makes the pass mean something.
   *
   * **The recursion break is mandatory once that is fixed, and it is keyed on two markers.** This file is
   * part of the root suite, so a real nested run re-enters here. The guard marker alone is not enough —
   * the sibling test below runs the check with `--simulate-no-guard`, where no guard marker exists — so
   * `BAYZ_OFFLINE_CHECK_DEPTH` is checked as well. Each level would spawn two children, and a measured
   * probe confirmed 2^n growth up to the host's process limit.
   */
  if (insideOfflineCheck()) {
    t.skip("already inside scripts/offline-check.mjs; spawning it again would recurse without end");
    return;
  }

  const result = execFileSync(process.execPath, [CHECK, "--suite", "root"], { encoding: "utf8", cwd: ROOT });
  assert.match(result, /offline check: PASS/, result);
  assert.match(result, /guard active: yes/i, result);

  const counts = /\((\d+) pass, (\d+) fail\)/.exec(result);
  assert.ok(counts !== null, `the nested suite reported no test counts, so nothing ran:\n${result}`);
  assert.ok(Number(counts[1]) > 100, `only ${counts[1]} tests ran offline, expected the whole root suite`);
  assert.equal(Number(counts[2]), 0, `${counts[2]} test(s) failed offline`);
});

test("the check refuses to report PASS if the guard was not active", (t) => {
  /*
   * **The anti-vacuity assertion.** A run that passes because the guard silently failed to load is
   * indistinguishable from a run that passes because nothing reached out — unless the check verifies its
   * own guard first. `--simulate-no-guard` skips the preload, and the check must refuse rather than
   * report a green result it cannot stand behind.
   *
   * **This is the test that made the recursion break load-bearing.** `--simulate-no-guard` deliberately
   * runs the check *without* the guard marker, so the marker-only break could not stop the nested run it
   * spawns; combined with the sibling test above, each level forked two children until the host killed
   * the tree. Hence `insideOfflineCheck()`, which also honours `BAYZ_OFFLINE_CHECK_DEPTH`.
   */
  if (insideOfflineCheck()) {
    t.skip("already inside scripts/offline-check.mjs; spawning it again would recurse without end");
    return;
  }

  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [CHECK, "--suite", "root", "--simulate-no-guard"], {
      encoding: "utf8",
      cwd: ROOT,
    });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  assert.equal(status, 1, `a run without the guard reported success:\n${output}`);
  assert.match(output, /offline check: FAIL/, output);
  assert.match(output, /guard/i, output);
});

test("the check refuses to re-enter itself, on both the guarded and the unguarded path", () => {
  /*
   * **The fork-bomb regression, end to end — and deliberately the *bounded* end of it.**
   *
   * `scripts/offline-check.mjs` runs the root suite; the root suite contains this file; this file runs the
   * check twice — plainly and with `--simulate-no-guard`. Left unbroken that is 2^n processes, and the
   * host does not fail it politely: it stops being able to fork and the whole tree dies by signal, which
   * looks exactly like an unexplained external kill. It took down three verification sessions on this
   * device, the third with RSS and process-count abort thresholds fitted — by the time a sampler notices,
   * the kill has already happened.
   *
   * **So the live reproduction is retired and must not be reinstated.** The growth property is proven
   * without processes in `tests/offline-recursion.test.mjs`, which intercepts the check's spawn seam,
   * substitutes a synthetic suite that always re-enters, and counts attempted descendants — including a
   * positive control that measures the 1, 2, 4, 8, 16 doubling against a vulnerable implementation.
   *
   * What remains here is the two-process confirmation that the refusal works through a *real* `execFileSync`
   * boundary and a real environment: the marker is forced, so each child refuses immediately and starts
   * nothing. Two processes, both short-lived, no recursion possible. The in-process harness cannot prove
   * this part — an injected `env` object is not evidence that the real inherited environment is read.
   */
  for (const [label, extra] of [
    ["depth marker", { [DEPTH_VARIABLE]: "1" }],
    ["depth marker on the unguarded path", { [DEPTH_VARIABLE]: "2" }],
  ]) {
    const args = label.includes("unguarded") ? [CHECK, "--suite", "root", "--simulate-no-guard"] : [CHECK, "--suite", "root"];
    let status = 0;
    let output = "";
    const started = Date.now();
    try {
      output = execFileSync(process.execPath, args, {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, ...extra },
      });
    } catch (error) {
      status = error.status ?? 1;
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    const seconds = (Date.now() - started) / 1000;

    assert.equal(status, 1, `${label}: a nested invocation did not refuse:\n${output}`);
    assert.match(output, /nested invocation refused/i, `${label}: ${output}`);
    assert.match(output, /offline check: FAIL/, `${label}: ${output}`);
    /*
     * Refusal must happen *before* any suite runs, so assert on evidence of work rather than only on the
     * message: no per-suite result line may appear. The timing bound is the coarse backstop — a run that
     * actually executed the root suite takes seconds, not milliseconds.
     */
    assert.ok(!/^\s+(ok|FAIL)\s+root/m.test(output), `${label}: the nested run executed a suite:\n${output}`);
    assert.ok(seconds < 5, `${label}: refusal took ${seconds}s, so it did work before refusing`);
  }
});

test("the check propagates the depth marker into the suites it runs", (t) => {
  /*
   * The refusal above is only reachable if the marker actually arrives in the child. Asserted through the
   * real script rather than by reading its source: a comment claiming propagation and an `env` that drops
   * it are indistinguishable from the outside, and the failure mode is a fork bomb.
   *
   * Skipped when already nested — the marker is inherited here, so the check would (correctly) refuse the
   * probe invocation. The refusal test above needs no skip, because it forces the marker itself and
   * asserts the refusal on purpose.
   */
  if (insideOfflineCheck()) {
    t.skip("already inside scripts/offline-check.mjs; the probe invocation would be refused, as designed");
    return;
  }

  /*
   * The marker name is defined in `scripts/offline-nesting.mjs` and imported here, so this asserts the
   * *wiring* rather than a string literal: the check must import the nesting module, and the module must
   * name the variable this test forces elsewhere. Previously this grepped the check for the literal, which
   * broke the moment the predicate was extracted — a source grep that tracks where code lives is a test of
   * layout, not behaviour.
   */
  const source = readFileSync(CHECK, "utf8");
  assert.match(source, /offline-nesting\.mjs/, "the check does not use the shared nesting predicate");
  assert.equal(DEPTH_VARIABLE, "BAYZ_OFFLINE_CHECK_DEPTH", "the depth marker was renamed; update the probe below");

  const dir = mkdtempSync(join(tmpdir(), "bayz-offline-depth-"));
  const file = join(dir, "depth.test.mjs");
  writeFileSync(
    file,
    `import test from "node:test";
     import assert from "node:assert/strict";
     test("the depth marker is present in the child", () => {
       assert.notEqual(process.env.BAYZ_OFFLINE_CHECK_DEPTH, undefined,
         "scripts/offline-check.mjs did not propagate BAYZ_OFFLINE_CHECK_DEPTH into the suite process");
     });`,
  );

  // Drive the check's own suite runner against a throwaway suite, so this asserts the real code path.
  const result = execFileSync(process.execPath, [CHECK, "--suite", "adhoc", "--adhoc-path", file], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.match(result, /offline check: PASS/, result);
  assert.match(result, /\(1 pass, 0 fail\)/, result);
});

test("the guard is not left installed in the normal test environment", (t) => {
  /*
   * The guard must be opt-in. Preloading it globally would break the install and upgrade smokes, which
   * legitimately reach the npm registry to install a real tarball.
   *
   * Skipped when the guard is deliberately active — `scripts/offline-check.mjs` runs this very suite with
   * the preload on, and asserting its absence there would be asserting the opposite of what that run is
   * for. The assertion still bites where it matters: every ordinary run of the suite, where the guard
   * must not appear.
   */
  if (process.env.BAYZ_OFFLINE_GUARD === "active") {
    t.skip("running under scripts/offline-check.mjs, where the guard is intentionally active");
    return;
  }

  const options = process.env.NODE_OPTIONS ?? "";
  assert.ok(!options.includes("offline-guard"), `NODE_OPTIONS preloads the guard globally: ${options}`);
});

test("the guard file itself declares why loopback is exempt", () => {
  // Documentation-as-assertion: the exemption is the guard's one hole, so its justification must be
  // written down where the next reader will find it rather than in a commit message.
  assert.ok(existsSync(GUARD), `${GUARD} does not exist`);
  const source = readFileSync(GUARD, "utf8");
  assert.match(source, /loopback/i, "the guard does not mention loopback");
  assert.match(source, /smoke/i, "the guard does not explain which tests need loopback");
});
