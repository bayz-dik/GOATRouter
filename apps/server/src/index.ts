import { StorageError } from "@bayz/storage";
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { createBayzRuntime, type BayzRuntime } from "./runtime.js";

const config = loadRuntimeConfig();

// The runtime is built before the listener starts: serving traffic with no working
// credential store, or with no API token, would be worse than refusing to start.
let runtime: BayzRuntime;
try {
  runtime = createBayzRuntime(config);
} catch (error) {
  const code = error instanceof StorageError ? error.code : "startup_failed";
  const stage = error instanceof StorageError ? error.stage : undefined;
  console.error(
    JSON.stringify({ level: "error", code, stage, msg: "Bayz Core failed to start" }),
  );
  process.exitCode = 1;
  throw error;
}

const app = buildApp({
  dashboardRoot: config.dashboardRoot,
  apiToken: runtime.apiToken,
  runtime,
});

app.log.info(
  { ...runtime.describe(), dataDir: config.dataDir, apiTokenSource: runtime.apiTokenSource },
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

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { url: `http://${config.host}:${config.port}`, dataDir: config.dataDir },
  "Bayz Core ready",
);
