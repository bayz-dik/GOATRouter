import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeConfig = {
  host: string;
  port: number;
  dataDir: string;
  dashboardRoot: string;
};

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const host = env.BAYZ_HOST ?? "127.0.0.1";
  const port = Number(env.BAYZ_PORT ?? "20128");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("BAYZ_PORT must be an integer from 1 to 65535");
  }
  const localHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!localHosts.has(host) && env.BAYZ_ALLOW_REMOTE !== "true") {
    throw new Error("Non-loopback BAYZ_HOST requires BAYZ_ALLOW_REMOTE=true");
  }
  return {
    host,
    port,
    dataDir: resolve(env.BAYZ_DATA_DIR ?? `${homedir()}/.bayz`),
    dashboardRoot: resolve(
      env.BAYZ_DASHBOARD_ROOT ??
        fileURLToPath(new URL("../../dashboard/dist/", import.meta.url)),
    ),
  };
}
