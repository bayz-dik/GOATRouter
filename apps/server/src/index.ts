import { StorageError } from "@bayz/storage";
import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";
import { describeStorage, initializeStorage, type StorageHandle } from "./storage.js";

const config = loadRuntimeConfig();
const app = buildApp({ dashboardRoot: config.dashboardRoot });

// Storage is initialized before the listener starts: serving traffic with no
// working credential store would be worse than refusing to start.
let storage: StorageHandle;
try {
  storage = initializeStorage(config);
} catch (error) {
  const code = error instanceof StorageError ? error.code : "storage_unavailable";
  const stage = error instanceof StorageError ? error.stage : undefined;
  app.log.error({ code, stage }, "Bayz Core storage unavailable");
  process.exitCode = 1;
  throw error;
}

app.log.info(describeStorage(storage, config.dataDir), "Bayz storage ready");

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Bayz Core stopping");
  await app.close();
  storage.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { url: `http://${config.host}:${config.port}`, dataDir: config.dataDir },
  "Bayz Core ready",
);
