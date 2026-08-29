import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeDataDir, type DataDirReason } from "./data-dir.js";
import { derivePosture } from "./posture.js";

export type RuntimeConfig = {
  host: string;
  port: number;
  dataDir: string;
  dashboardRoot: string;
  /**
   * Why the data directory is where it is (9J Task 3).
   *
   * Optional because every existing test fixture builds a `RuntimeConfig` by hand, and making it
   * required would force a value into dozens of fixtures that never read it. `index.ts` logs it so an
   * operator can see which link in the fallback chain was taken — the difference between "your
   * existing directory was found" and "a new platform-default one was created" is the difference
   * between a working upgrade and an apparently empty install.
   */
  dataDirReason?: DataDirReason;
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
  /*
   * The data directory comes from `data-dir.ts` and nowhere else (9J Task 3).
   *
   * `resolveRuntimeDataDir` is called rather than `resolveDataDir` because this file must not read
   * the real platform or home directory itself — `tests/portability.test.mjs` asserts the resolver is
   * the only file in the repository that does. The injected `env` is still passed through, so an
   * explicit `BAYZ_DATA_DIR` in a test fixture reaches the resolver.
   *
   * `resolve()` is deliberately *not* applied to the result. The resolver already returns an absolute
   * path, and running `resolve()` over a Windows answer while executing on POSIX would rewrite
   * `C:\Users\x\AppData\Local\bayz` into a path relative to the current working directory. The
   * dashboard root below still uses `resolve()`, because that value is always a path on the machine
   * this process is running on.
   */
  const dataDir = resolveRuntimeDataDir(env);
  return {
    host,
    port,
    dataDir: dataDir.path,
    dataDirReason: dataDir.reason,
    dashboardRoot: resolve(
      env.BAYZ_DASHBOARD_ROOT ??
        fileURLToPath(new URL("../../dashboard/dist/", import.meta.url)),
    ),
  };
}
