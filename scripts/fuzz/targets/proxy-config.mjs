/**
 * Fuzz target: proxy configuration and endpoint parsing — 9I Task 3.
 *
 * Proxy config is where an operator's own hostnames and a stored password meet
 * attacker-influenceable text. `parseProxyConfig` refuses unknown keys for the same reason the
 * provider one does: no key in the schema can carry a command, a header, or a password, and an
 * attempt to add one must fail loudly rather than be dropped.
 */

import { generateIdentifier, generateJsonValue, generateUtf8String } from "../generators.mjs";
import { assertGlobalStateUnchanged, globalStateSnapshot, rejectOrAccept } from "./shared.mjs";

const {
  CONNECT_TIMEOUT_MS_MAX,
  CONNECT_TIMEOUT_MS_MIN,
  parseProxyConfig,
} = await import("../../../packages/proxy/src/config.ts");
const { PROXY_KINDS, assertProxyKind, parseProxyEndpoint, parseProxyHost, parseProxyPort } = await import(
  "../../../packages/proxy/src/endpoint.ts"
);
const { parseProxyUsername } = await import("../../../packages/proxy/src/repository.ts");

const CODES = new Set(["invalid_proxy_config", "invalid_proxy_id"]);

function generate(rng) {
  switch (rng.int(0, 4)) {
    case 0:
      return { which: "config", value: generateJsonValue(rng) };
    case 1: {
      const config = {};
      if (rng.bool())
        config.connectTimeoutMs = rng.pick([
          CONNECT_TIMEOUT_MS_MIN,
          CONNECT_TIMEOUT_MS_MAX,
          CONNECT_TIMEOUT_MS_MIN - 1,
          CONNECT_TIMEOUT_MS_MAX + 1,
          0,
          -1,
          1.5,
          "5000",
        ]);
      if (rng.bool()) config.healthCheckHost = rng.int(0, 2) === 0 ? generateIdentifier(rng) : "example.com";
      if (rng.bool()) config.healthCheckPort = rng.pick([443, 0, 1, 65535, 65536, -1, "443", 1.5]);
      if (rng.int(0, 3) === 0) config[generateIdentifier(rng)] = 1;
      if (rng.int(0, 8) === 0) {
        const hostile = Object.create({ connectTimeoutMs: 1 });
        Object.assign(hostile, config);
        return { which: "config", value: hostile };
      }
      return { which: "config", value: config };
    }
    case 2:
      return { which: "endpoint", host: rng.int(0, 2) === 0 ? generateIdentifier(rng) : "127.0.0.1", port: rng.pick([1080, 0, 65536, -1, "1080", null, 1.5]) };
    case 3:
      return { which: "kind", value: rng.int(0, 2) === 0 ? rng.pick([...PROXY_KINDS]) : generateIdentifier(rng) };
    default:
      return { which: "username", value: rng.int(0, 3) === 0 ? generateUtf8String(rng) : generateIdentifier(rng) };
  }
}

function run(input, { iteration }) {
  const before = globalStateSnapshot();
  const context = `proxy-config#${iteration}/${input.which}`;

  switch (input.which) {
    case "config": {
      const outcome = rejectOrAccept(() => parseProxyConfig(input.value), CODES, context);
      if (outcome.accepted) {
        const parsed = outcome.value;
        if (parsed.connectTimeoutMs < CONNECT_TIMEOUT_MS_MIN || parsed.connectTimeoutMs > CONNECT_TIMEOUT_MS_MAX) {
          throw new Error(`${context}: accepted an out-of-range connectTimeoutMs (${parsed.connectTimeoutMs})`);
        }
        if (!Number.isInteger(parsed.healthCheckPort) || parsed.healthCheckPort < 1 || parsed.healthCheckPort > 65535) {
          throw new Error(`${context}: accepted an out-of-range healthCheckPort (${parsed.healthCheckPort})`);
        }
      }
      break;
    }
    case "endpoint": {
      const outcome = rejectOrAccept(() => parseProxyEndpoint({ host: input.host, port: input.port }), CODES, context);
      if (outcome.accepted) {
        const { host, port } = outcome.value;
        if (typeof host !== "string" || host.length === 0) throw new Error(`${context}: accepted an empty host`);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${context}: accepted port ${port}`);
      }
      // The individual parsers must agree with the composite one.
      rejectOrAccept(() => parseProxyHost(input.host), CODES, `${context}/host`);
      rejectOrAccept(() => parseProxyPort(input.port), CODES, `${context}/port`);
      break;
    }
    case "kind": {
      const outcome = rejectOrAccept(() => assertProxyKind(input.value), CODES, context);
      if (outcome.accepted && !PROXY_KINDS.includes(outcome.value)) {
        throw new Error(`${context}: accepted an unknown proxy kind: ${JSON.stringify(outcome.value)}`);
      }
      break;
    }
    default: {
      const outcome = rejectOrAccept(() => parseProxyUsername(input.value), CODES, context);
      if (outcome.accepted && outcome.value !== undefined) {
        /*
         * A username reaches a SOCKS5 RFC 1929 field and an HTTP CONNECT Basic header. A
         * control character in either would split the header block, so an accepted username
         * must be free of them — `http-connect.ts` refuses them at dial time, and this asserts
         * the earlier boundary does not hand it something it must then reject.
         */
        if (/[\u0000-\u001f\u007f]/.test(outcome.value)) {
          throw new Error(`${context}: accepted a username containing control characters`);
        }
      }
      break;
    }
  }

  assertGlobalStateUnchanged(before, context);
}

export const target = {
  name: "proxy-config",
  seed: "9i-proxy-config-1",
  iterations: 5000,
  generate,
  run,
};
