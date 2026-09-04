/**
 * CLI wiring for `bayz update` and `bayz --check-update`.
 *
 * Kept separate from `index.ts` (which starts the server) so the packed bin can
 * run an update without importing the server. Resolves the installed package
 * root from this module's own location inside the installed `bayz-router`
 * package.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkUpdate, runUpdate } from "./self-update.js";

/** The installed package root: <prefix>/node_modules/bayz-router */
function packageRoot() {
  if (process.env.BAYZ_UPDATE_PACKAGE_ROOT !== undefined) {
    return process.env.BAYZ_UPDATE_PACKAGE_ROOT;
  }
  // This file lives at <pkg>/dist/update-cli.mjs; the package root is one level up.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export async function mainUpdate() {
  const root = packageRoot();
  const tempDir = mkdtempSync(join(tmpdir(), "bayz-update-"));
  try {
    const report = await runUpdate({ packageRoot: root, tempDir });
    if (report.action === "current") {
      console.log(`GOAT ROUTER is already at the latest release (${report.current}).`);
      return 0;
    }
    console.log(`Updated GOAT ROUTER ${report.from} -> ${report.to}.`);
    console.log(`Artifact SHA256: ${report.sha}`);
    console.log("Runtime data was not touched.");
    return 0;
  } catch (error) {
    console.error(`goat update: ${error instanceof Error ? error.message : String(error)}`);
    console.error("The previous release was restored. Runtime data was not touched.");
    return 1;
  }
}

export async function mainCheckUpdate() {
  const root = packageRoot();
  const report = await checkUpdate(root);
  if (report.error !== undefined) {
    console.log(`GOAT ROUTER ${report.current}`);
    console.log(`Could not check for updates: ${report.error}`);
    return 1;
  }
  if (report.updateAvailable) {
    console.log(`GOAT ROUTER ${report.current} — update available: ${report.latest}`);
    console.log("Run:  bayz update");
    return 1;
  }
  console.log(`GOAT ROUTER ${report.current} is up to date (latest ${report.latest}).`);
  return 0;
}
