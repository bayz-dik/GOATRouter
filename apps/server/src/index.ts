import { StorageError } from "@bayz/storage";
import { registerLocalListener } from "@bayz/proxy";
import { configureOutboundConcurrency } from "@bayz/router";
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { PostureError, resolvePosture } from "./posture.js";
import { createBayzRuntime, type BayzRuntime } from "./runtime.js";
import { TlsError, loadTlsConfig, type TlsConfig } from "./tls.js";

const config = loadRuntimeConfig();

function failStartup(error: unknown, code: string, stage?: string): never {
  console.error(
    JSON.stringify({ level: "error", code, stage, msg: "Bayz Core failed to start" }),
  );
  process.exitCode = 1;
  throw error;
}

// The runtime is built before the listener starts: serving traffic with no working
// credential store, or with no API token, would be worse than refusing to start.
let runtime: BayzRuntime;
try {
  runtime = createBayzRuntime(config);
} catch (error) {
  failStartup(
    error,
    error instanceof StorageError ? error.code : "startup_failed",
    error instanceof StorageError ? error.stage : undefined,
  );
}

/*
 * TLS is loaded before the posture gate, so an unreadable certificate is reported as a
 * TLS failure naming the variable rather than as "lan requires TLS" — which would send
 * an operator who *did* configure TLS looking in the wrong place.
 */
let tls: TlsConfig | undefined;
try {
  tls = loadTlsConfig(process.env);
} catch (error) {
  runtime.close();
  failStartup(
    error,
    "tls_refused",
    error instanceof TlsError ? error.requirement : undefined,
  );
}

/*
 * The posture gate (9F Task 6).
 *
 * Deliberately after the runtime is built, because whether the API token was supplied
 * by the operator is only known once it has been resolved — a *stored* token counts as
 * explicit, since the operator kept it, while a freshly generated one does not.
 *
 * Deliberately before `listen`, because a `lan` or `remote` listener missing TLS or
 * client authentication must never accept a single request. Nothing here warns: a
 * warning printed to a log the operator is not reading is indistinguishable from no
 * protection at all.
 */
let posture: ReturnType<typeof resolvePosture>;
try {
  posture = resolvePosture({
    host: config.host,
    env: process.env,
    apiTokenExplicit: runtime.apiTokenSource !== "generated",
  });
} catch (error) {
  runtime.close();
  failStartup(
    error,
    "posture_refused",
    error instanceof PostureError ? error.requirement : undefined,
  );
}

const app = buildApp({
  dashboardRoot: config.dashboardRoot,
  apiToken: runtime.apiToken,
  runtime,
  posture: posture.posture,
  rateLimit: { max: posture.limits.max, authMax: posture.limits.authMax },
  concurrency: posture.limits.concurrency,
  ...(tls === undefined ? {} : { https: tls }),
  // Signing is required when the operator asked for it, and also whenever `remote`
  // posture was satisfied by signing rather than by mutual TLS — otherwise the
  // requirement would have been *declared* met and never enforced.
  requireSigning: posture.requestSigning,
});

app.log.info(
  {
    ...runtime.describe(),
    dataDir: config.dataDir,
    // Which link in the 9J Task 3 fallback chain was taken. `existing` means an established
    // `~/.bayz` was found and reused; `platform-default` means a new directory was created because
    // none existed. An operator staring at an apparently empty install needs to be able to tell
    // those apart, and the reason is an enum — no environment dump, so no key can ride along.
    dataDirReason: config.dataDirReason,
    apiTokenSource: runtime.apiTokenSource,
    // Operational shape only: which posture was derived and which protections are in
    // effect. No certificate path, no token, no key.
    posture: posture.posture,
    tls: posture.tls,
    mutualTls: posture.mutualTls,
    requestSigning: posture.requestSigning,
    concurrency: posture.limits.concurrency,
  },
  "Bayz storage ready",
);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Bayz Core stopping");
  await app.close();
  runtime.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

/*
 * Tell the proxy layer where this process listens (9F Task 8).
 *
 * Registered before `listen`, so no request can be served during a window in which a
 * proxy-bound route could tunnel back into BAYZ itself. The registry lives in
 * `@bayz/proxy` rather than being a constant there because the bind address is
 * configuration: a hard-coded `127.0.0.1:20128` would miss a `lan` deployment and miss
 * a non-default port.
 */
registerLocalListener({ host: config.host, port: config.port });

/*
 * Apply the posture's in-flight cap to outbound requests too.
 *
 * The server-side cap bounds how many callers BAYZ serves; this bounds how many
 * upstream sockets it holds. They are different resources and a limit on one says
 * nothing about the other.
 */
configureOutboundConcurrency({ limit: posture.limits.concurrency });

await app.listen({ host: config.host, port: config.port });
app.log.info(
  {
    url: `${posture.tls ? "https" : "http"}://${config.host}:${config.port}`,
    dataDir: config.dataDir,
    posture: posture.posture,
  },
  "Bayz Core ready",
);
