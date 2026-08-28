/**
 * Hermes-specific setup for `scripts/verify-hermes.mjs` — 9H Task 5.
 *
 * Everything here was read from the live machine, never composed from documentation:
 * `~/.hermes/config.yaml` uses **snake_case** `model.base_url`, `provider: custom`,
 * `api_mode: chat_completions`, an `api_key: ${VAR}` reference, and **bare** model ids —
 * and the key itself lives in `~/.hermes/.env` under a variable derived from the endpoint's
 * host and port.
 *
 * The env-var name is generated the way Hermes itself generates it
 * (`hermes_cli/config.py: custom_endpoint_key_env`): upper-case the `host_port` identity and
 * replace every run of non-alphanumerics with `_`, behind a fixed `HERMES_CUSTOM_` prefix.
 * Hard-coding `HERMES_CUSTOM_127_0_0_1_20128_API_KEY` would have broken instantly, because
 * every scenario binds an ephemeral port.
 *
 * **`api_key: ${VAR}` in config.yaml is load-bearing.** The first probe wrote only the
 * `.env` entry and Hermes answered `HTTP 401: A valid API token is required` with **zero**
 * requests reaching BAYZ — the credential was never sent. The YAML must reference the
 * variable for the `.env` value to be used, which is exactly what the live file does.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Mirror of Hermes's own `custom_endpoint_key_env` for a `host_port` identity. */
function keyEnvVarFor(host, port) {
  const slug = `${host}_${port}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug.length > 0 ? `HERMES_CUSTOM_${slug}_API_KEY` : "HERMES_CUSTOM_API_KEY";
}

/**
 * Write a real Hermes configuration into a throwaway HERMES_HOME.
 *
 * `HERMES_HOME` *and* `HOME` are both redirected. `HERMES_HOME` alone would still leave
 * some paths resolving under the real `$HOME`, and this agent is itself Hermes — a stray
 * write into `~/.hermes` could destroy the session performing the verification.
 */
function configureHermes({ base, key, model = "probe-model", port }) {
  const home = mkdtempSync(join(tmpdir(), "bayz-hm-home-"));
  mkdirSync(home, { recursive: true });
  const envVar = keyEnvVarFor("127.0.0.1", port);

  const configYaml = [
    "model:",
    `  default: ${model}`,
    "  provider: custom",
    `  base_url: ${base}/v1`,
    `  api_key: \${${envVar}}`,
    "  api_mode: chat_completions",
    "",
    "custom_providers:",
    "  - name: BAYZ Local",
    `    base_url: ${base}/v1`,
    `    model: ${model}`,
    "    api_mode: chat_completions",
    `    key_env: ${envVar}`,
    "    models:",
    `      ${model}: {}`,
    "",
  ].join("\n");

  writeFileSync(join(home, "config.yaml"), configYaml);
  writeFileSync(join(home, ".env"), `${envVar}=${key}\n`, { mode: 0o600 });

  const env = { ...process.env, HERMES_HOME: home, HOME: home };
  // Inherited agent-runtime variables would leak this harness's own execution context into
  // the child, so they are stripped.
  for (const name of ["BH_AGENT_WORKSPACE", "HERMES_SESSION_ID", "HERMES_IGNORE_USER_CONFIG"]) {
    delete env[name];
  }

  return {
    home,
    envVar,
    configPath: join(home, "config.yaml"),
    configYaml,
    cwd: home,
    env,
  };
}

export { configureHermes, keyEnvVarFor };
