import { buildApp } from "./app.js";
import { loadRuntimeConfig } from "./config.js";

const config = loadRuntimeConfig();
const app = buildApp({ dashboardRoot: config.dashboardRoot });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Bayz Core stopping");
  await app.close();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { url: `http://${config.host}:${config.port}`, dataDir: config.dataDir },
  "Bayz Core ready",
);
