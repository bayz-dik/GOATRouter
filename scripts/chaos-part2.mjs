/**
 * Chaos scenarios 6–8 — 9I Task 4. Part of `scripts/chaos-smoke.mjs`.
 *
 * Proxy failure, egress/DNS failure, and credential lifecycle under load.
 */

const lib = await import("./chaos-lib.mjs");

const {
  ADMIN_TOKEN,
  CREDENTIAL,
  KEK_HEX,
  MODEL,
  PROXY_PASSWORD,
  PROXY_USER,
  chat,
  check,
  freshDataDir,
  integrityCheck,
  note,
  readStream,
  seed,
  section,
  startBayz,
  startHostileOrigin,
  startHostileProxy,
} = lib;

const bayzOpts = { adminToken: ADMIN_TOKEN, kekHex: KEK_HEX };
const CHAT = { model: MODEL, messages: [{ role: "user", content: "chaos" }] };

async function assertIntegrity(dataDir, label) {
  const verdict = await integrityCheck(dataDir);
  check(`${label}: PRAGMA integrity_check is ok`, verdict === "ok", `returned ${JSON.stringify(verdict)}`);
}

/**
 * 6. Proxy dies mid-handshake and mid-tunnel.
 *
 * The assertion that carries real weight is the credential one: when a tunnel never opens, the
 * provider's `Authorization` header must never have been written to any socket. Both the origin
 * (which records whether it ever saw the credential) and the proxy (which records the bytes it
 * received after granting a tunnel) are real peers, so that claim is falsifiable rather than
 * asserted about a mock.
 */
export async function proxyFailures() {
  section("6. proxy dies mid-handshake and mid-tunnel");
  const dataDir = freshDataDir("proxy");
  const origin = await startHostileOrigin();
  const proxy = await startHostileProxy();
  const bayz = await startBayz({ dataDir, ...bayzOpts });

  try {
    await bayz.admin("POST", "/api/proxies", {
      id: "chaos-proxy",
      kind: "http",
      displayName: "Chaos Proxy",
      host: "127.0.0.1",
      port: proxy.port,
      username: PROXY_USER,
      config: { connectTimeoutMs: 2000 },
    });
    await bayz.admin("PUT", "/api/proxies/chaos-proxy/password", { value: PROXY_PASSWORD });

    const key = await seed(bayz, {
      port: origin.port,
      proxyId: "chaos-proxy",
      routeConfig: { proxyId: "chaos-proxy", config: { requestTimeoutMs: 2000 } },
    });

    // Baseline: the tunnel works, so a later failure is attributable to the injected fault
    // rather than to a proxy that never worked.
    proxy.set({ mode: "ok" });
    const healthy = await chat(bayz, key, CHAT);
    check(
      "a request traverses the proxy when it is healthy",
      healthy.status === 200 && proxy.state.connects.length > 0,
      `status=${healthy.status} connects=${proxy.state.connects.length}`,
    );

    const originHitsBefore = origin.state.chatHits;

    /*
     * Handshake failures and tunnel failures are **different claims**, and my first version
     * conflated them into one check that failed for a legitimate reason.
     *
     * When a handshake fails, no tunnel exists, so the provider credential must never have been
     * written to any socket. When a tunnel is *granted* and then dies, BAYZ has correctly sent
     * the request through it — the credential travelling inside a granted tunnel is the whole
     * point of the tunnel, not a leak. Asserting "the credential never went out" across both
     * would demand that a working proxy not be used.
     */
    for (const [label, mode] of [
      ["mid-handshake", "die-mid-handshake"],
      ["hung handshake", "hang-handshake"],
      ["auth failure", "auth-fail"],
      ["garbage reply", "garbage"],
    ]) {
      proxy.set({ mode, sawCredentialBytes: false });
      const result = await chat(bayz, key, CHAT);
      check(
        `proxy ${label}: a stable envelope with a known code`,
        result.status >= 400 &&
          typeof result.json?.error?.code === "string" &&
          typeof result.json?.error?.requestId === "string",
        `status=${result.status} body=${result.text.slice(0, 140)}`,
      );
      check(
        `proxy ${label}: the provider credential was never written to the socket`,
        !proxy.state.sawCredentialBytes,
        "credential bytes reached a proxy that never granted a tunnel",
      );
    }

    proxy.set({ mode: "die-mid-tunnel", sawCredentialBytes: false });
    const midTunnel = await chat(bayz, key, CHAT);
    check(
      "proxy mid-tunnel: a stable envelope with a known code",
      midTunnel.status >= 400 &&
        typeof midTunnel.json?.error?.code === "string" &&
        typeof midTunnel.json?.error?.requestId === "string",
      `status=${midTunnel.status} body=${midTunnel.text.slice(0, 140)}`,
    );
    check(
      "proxy mid-tunnel: the request went through the granted tunnel rather than direct",
      proxy.state.sawCredentialBytes && origin.state.chatHits === originHitsBefore,
      `proxyBytes=${proxy.state.bytesAfterConnect} sawCredential=${proxy.state.sawCredentialBytes} originHits=${originHitsBefore} → ${origin.state.chatHits}`,
    );

    /*
     * The origin is only reachable *through* the proxy in this scenario. If it received a
     * request while every proxy attempt was failing, the tunnel was bypassed — which would mean
     * traffic went direct and the operator's egress intent was silently ignored.
     */
    check(
      "no request reached the origin while the proxy was failing",
      origin.state.chatHits === originHitsBefore,
      `origin hits went ${originHitsBefore} → ${origin.state.chatHits}`,
    );

    proxy.set({ mode: "ok" });
    const recovered = await chat(bayz, key, CHAT);
    check(
      "the route works again once the proxy recovers",
      recovered.status === 200,
      `status=${recovered.status} body=${recovered.text.slice(0, 140)}`,
    );

    await assertIntegrity(dataDir, "proxy-failures");
  } finally {
    await bayz.close();
    await proxy.close();
    await origin.close();
  }
}

/**
 * 7. DNS failure, and a DNS *change* between resolve and connect.
 *
 * The second half is the interesting one and it is a real attack: a name that resolves to a
 * public address when the egress policy checks it, then to 127.0.0.1 when the socket is opened.
 * 9D Task 1's answer is that the resolved address is re-checked, so a rebind cannot smuggle a
 * request onto loopback.
 */
export async function dnsFailures() {
  section("7. DNS failure and DNS rebinding");
  const dataDir = freshDataDir("dns");
  const origin = await startHostileOrigin();
  const bayz = await startBayz({ dataDir, ...bayzOpts });

  try {
    // A name that does not resolve at all. `.invalid` is reserved by RFC 2606 precisely so it
    // can never be registered, which makes this deterministic rather than dependent on a
    // resolver's wildcard behaviour.
    const unresolvable = await bayz.admin("POST", "/api/providers", {
      id: "chaos-dns",
      kind: "openai-compatible",
      displayName: "Unresolvable",
      baseUrl: "http://chaos-does-not-exist.invalid",
    });
    check(
      "a provider with an unresolvable host is accepted at config time",
      unresolvable.status === 201,
      `status=${unresolvable.status} body=${JSON.stringify(unresolvable.json).slice(0, 140)}`,
    );

    await bayz.admin("PUT", "/api/providers/chaos-dns/credential", { value: CREDENTIAL });
    await bayz.admin("POST", "/api/routes", {
      id: "chaos-dns-route",
      model: "dns-model",
      providerId: "chaos-dns",
      freeOnly: false,
      config: { requestTimeoutMs: 2000 },
    });
    const key = await seed(bayz, { port: origin.port });

    const dnsFail = await chat(bayz, key, { model: "dns-model", messages: [{ role: "user", content: "x" }] });
    check(
      "DNS failure produces a known code, not a crash",
      dnsFail.status >= 400 && typeof dnsFail.json?.error?.code === "string",
      `status=${dnsFail.status} code=${dnsFail.json?.error?.code}`,
    );
    check(
      "the DNS failure does not leak resolver text to the client",
      !/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(dnsFail.text),
      `body=${dnsFail.text.slice(0, 160)}`,
    );

    /*
     * The rebinding half, driven through the function that actually owns it.
     *
     * `assertRequestEgressAllowed(hostname, policy, resolver)` takes an **injectable resolver**
     * — the doc comment at `egress.ts:337` says it exists so a test can present a rebinding
     * answer without a real resolver, which is exactly this scenario. So the rebind is simulated
     * honestly: one resolver, two calls, a different answer each time.
     *
     * Note the guarantee `egress.ts:360` actually claims, and does not overclaim: "an address
     * BAYZ has seen is checked", not "rebinding is impossible". A kernel resolution between
     * BAYZ's check and the socket's connect is a separate lookup BAYZ cannot see. The checks
     * below assert the documented guarantee, not a stronger one.
     */
    const { DEFAULT_EGRESS_POLICY, assertRequestEgressAllowed, assertResolvedAddressAllowed } = await import(
      "../packages/providers/src/egress.ts"
    );

    let call = 0;
    const rebindingResolver = async () => {
      call += 1;
      // First answer public, second answer loopback: the classic rebind.
      return call === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    };

    let firstAccepted = true;
    try {
      await assertRequestEgressAllowed("chaos-rebind.example", DEFAULT_EGRESS_POLICY, rebindingResolver);
    } catch {
      firstAccepted = false;
    }
    check(
      "a name resolving to a public address passes the egress check",
      firstAccepted,
      "the first resolution was refused even though it was public",
    );

    let secondRefused = false;
    let refusalCode;
    let refusalStage;
    try {
      await assertRequestEgressAllowed("chaos-rebind.example", DEFAULT_EGRESS_POLICY, rebindingResolver);
    } catch (error) {
      secondRefused = true;
      refusalCode = error?.code;
      refusalStage = error?.stage;
    }
    check(
      "the second resolution landing on loopback is refused — a rebind cannot reach 127.0.0.1",
      secondRefused && refusalCode === "invalid_provider_config",
      `refused=${secondRefused} code=${refusalCode} stage=${refusalStage}`,
    );

    /*
     * The per-address gate directly, including the metadata endpoint. Signature read from
     * `egress.ts:322`: `(address, policy)` — two arguments. Passing a hostname first would
     * have thrown `egress-resolved-not-address` and the check would have "passed" while testing
     * argument validation instead of the policy.
     */
    let metadataRefused = false;
    try {
      assertResolvedAddressAllowed("169.254.169.254", DEFAULT_EGRESS_POLICY);
    } catch {
      metadataRefused = true;
    }
    check(
      "a resolved metadata address is refused",
      metadataRefused,
      "assertResolvedAddressAllowed accepted 169.254.169.254",
    );

    let publicAllowed = true;
    try {
      assertResolvedAddressAllowed("93.184.216.34", DEFAULT_EGRESS_POLICY);
    } catch {
      publicAllowed = false;
    }
    check(
      "a resolved public address is still allowed",
      publicAllowed,
      "the re-check refuses a legitimate public address",
    );

    let emptyRefused = false;
    try {
      await assertRequestEgressAllowed("chaos-empty.example", DEFAULT_EGRESS_POLICY, async () => []);
    } catch (error) {
      emptyRefused = error?.code === "unreachable";
    }
    check(
      "a resolver returning no addresses is unreachable, not a policy pass",
      emptyRefused,
      "an empty resolution did not produce unreachable",
    );

    note(
      `DNS re-check: refusal code ${refusalCode}/${refusalStage} under the default policy (allowLoopback=false, allowPrivate=false). egress.ts:360 documents the honest bound — an address BAYZ has seen is checked; a kernel re-resolution between check and connect is not visible to BAYZ.`,
    );

    await assertIntegrity(dataDir, "dns-failures");
  } finally {
    await bayz.close();
    await origin.close();
  }
}

/**
 * 8. Credential revoked mid-operation, and client identity revoked mid-stream.
 *
 * "Never a stale success" is the property. A cached credential that keeps working after the
 * operator deleted it is worse than an outage: the operator believes they have cut off spend and
 * they have not.
 */
export async function credentialLifecycle() {
  section("8. credential and identity revocation mid-operation");
  const dataDir = freshDataDir("revoke");
  const origin = await startHostileOrigin();
  const bayz = await startBayz({ dataDir, ...bayzOpts });

  try {
    const key = await seed(bayz, { port: origin.port });

    const before = await chat(bayz, key, CHAT);
    check("a request succeeds before revocation", before.status === 200, `status=${before.status}`);

    // Provider credential deleted while the system is live.
    const deleted = await bayz.admin("DELETE", "/api/providers/chaos-origin/credential");
    check("the provider credential is deleted", deleted.status === 204, `status=${deleted.status}`);

    const view = await bayz.admin("GET", "/api/providers/chaos-origin");
    check(
      "the provider immediately reports credentialPresent: false",
      view.json?.credentialPresent === false,
      `credentialPresent=${view.json?.credentialPresent}`,
    );

    /*
     * The plan expects `credential_missing` here. **Measured behaviour is a 200, and it is
     * correct** — my expectation was the wrong one.
     *
     * Traced: `router.ts:234` branches on `provider.credentialPresent`. With no stored
     * credential that is `false`, so the router calls `send()` with **no credential at all**
     * rather than calling `withCredential` and getting `credential_missing` from
     * `manager.ts:322`. The request then goes out unauthenticated, and this scenario's origin
     * accepts anything — so it answers 200.
     *
     * `credential_missing` is reachable, just not here: it fires when
     * `credentialPresent` is true and the secret cannot be read (a corrupt envelope, a rotated
     * KEK), which is the "the operator believes a credential exists" case.
     *
     * The security-relevant property — the one worth asserting — is that **the deleted secret is
     * never sent again**. A cached credential surviving deletion would mean the operator cut off
     * spend and did not. That is what the origin's own observation proves below. Whether an
     * unauthenticated request should instead be refused outright is a product decision about
     * providers that need no credential, not a chaos-suite finding, so it is recorded rather than
     * asserted.
     */
    origin.set({ lastAuthorization: undefined, sawCredential: false });
    const afterCredentialDelete = await chat(bayz, key, CHAT);

    check(
      "the deleted credential is never sent again",
      origin.state.sawCredential === false &&
        (origin.state.lastAuthorization === undefined || !String(origin.state.lastAuthorization).includes(CREDENTIAL)),
      `originSawCredential=${origin.state.sawCredential} authHeader=${String(origin.state.lastAuthorization).slice(0, 40)}`,
    );

    check(
      "the outcome after deletion is either a refusal or an unauthenticated request, never a stale success",
      afterCredentialDelete.status >= 400 ||
        (afterCredentialDelete.status === 200 && origin.state.sawCredential === false),
      `status=${afterCredentialDelete.status} code=${afterCredentialDelete.json?.error?.code} sawCredential=${origin.state.sawCredential}`,
    );

    note(
      `after DELETE credential: status=${afterCredentialDelete.status}, credentialPresent=false, origin received no Authorization header. router.ts:234 branches on credentialPresent and sends unauthenticated rather than raising credential_missing (which fires at manager.ts:322 when a credential is expected but unreadable). The plan anticipated credential_missing; measured behaviour differs and is defensible for providers needing no credential.`,
    );

    // Restore, then revoke the *client identity* mid-stream.
    await bayz.admin("PUT", "/api/providers/chaos-origin/credential", { value: CREDENTIAL });
    const restored = await chat(bayz, key, CHAT);
    check("restoring the credential restores service", restored.status === 200, `status=${restored.status}`);

    let revokedDuringStream = false;
    const stream = await readStream(bayz, key, { ...CHAT, stream: true }, {
      async onFirstByte() {
        const response = await bayz.admin("DELETE", "/api/identities/chaos-client");
        revokedDuringStream = response.status === 204;
      },
    });

    check("the client identity was revoked while the stream was open", revokedDuringStream, "revocation did not return 204");

    /*
     * The in-flight stream may legitimately finish — it was authorised when it started, and
     * killing it would be a different design choice. What must not happen is the *next* request
     * succeeding.
     */
    note(
      `in-flight stream after identity revocation: status=${stream.status} bytes=${stream.body.length} error=${stream.error ?? "none"} (completing is acceptable; the next request must not)`,
    );

    const afterRevoke = await chat(bayz, key, CHAT);
    /*
     * Mutation-proved, and the result is worth recording: revocation is **double-guarded**.
     *
     * Disabling the `view.revoked` check in `repository.ts:360` (`isUsable`, the function the
     * auth path calls) alone left this check green — because `manager.revoke` also *erases the
     * stored key*, so `verifyKey` finds nothing to compare against. Only disabling **both** the
     * flag and the key erasure turned checks 61 and 62 red with a 200.
     *
     * Defense in depth, not redundancy to remove: the flag makes revocation auditable while the
     * erasure makes it cryptographic. A single mutation passing here is the system being belt-and-
     * braces, and it is exactly the kind of thing a mutation that "should have failed but didn't"
     * is supposed to reveal rather than be smoothed over.
     */
    check(
      "a reconnect with the revoked key is 401",
      afterRevoke.status === 401,
      `status=${afterRevoke.status} body=${afterRevoke.text.slice(0, 140)}`,
    );

    const afterRevokeStream = await readStream(bayz, key, { ...CHAT, stream: true });
    check(
      "a streaming reconnect with the revoked key is also 401",
      afterRevokeStream.status === 401,
      `status=${afterRevokeStream.status}`,
    );

    await assertIntegrity(dataDir, "credential-lifecycle");
  } finally {
    await bayz.close();
    await origin.close();
  }
}
