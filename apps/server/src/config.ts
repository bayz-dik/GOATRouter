import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { derivePosture } from "./posture.js";

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
  /*
   * The remote opt-in check now shares `derivePosture` with the posture ladder.
   *
   * The old inline `localHosts` set recognised only `127.0.0.1`, `::1`, and
   * `localhost`, so a bind to `127.0.0.53` — a real loopback address, and the one
   * systemd-resolved uses — was misclassified as remote and refused. Sharing one
   * classifier removes the possibility of the gate and the ladder disagreeing.
   *
   * `posture` is deliberately *not* returned on this type: it is derived, and adding a
   * field would force every existing `createBayzRuntime` fixture to carry a value the
   * runtime never reads. `index.ts` resolves the full posture separately.
   */
  if (derivePosture(host) !== "loopback" && env.BAYZ_ALLOW_REMOTE !== "true") {
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
