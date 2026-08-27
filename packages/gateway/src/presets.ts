import { DEFAULT_CLIENT_SCOPES, type ClientScope } from "@bayz/identity";
import type { ClientCapability } from "./capabilities.js";

export type ClientPreset = {
  readonly capabilities: readonly ClientCapability[];
  readonly scopes: readonly ClientScope[];
};

export type ClientPresetName =
  | "opencode"
  | "hermes"
  | "antigravity"
  | "generic-openai";

/**
 * Named presets are **configuration convenience only**.
 *
 * This file is the single place in `packages/gateway` where a product name may
 * appear, and `adversarial.test.ts` enforces that by scanning every other source
 * file for these strings. What a preset does is seed a default capability and
 * scope set when an operator registers a client identity — nothing more. There is
 * no URL, no header, no behaviour hook, and no function, because a behaviour hook
 * keyed by product name is exactly the architecture Phase 9 forbids.
 *
 * A future client with an unrecognized name and standard behaviour needs no change
 * here: `presetFor` falls back to `generic-openai` rather than failing.
 */
const PRESETS: Readonly<Record<ClientPresetName, ClientPreset>> = Object.freeze({
  // Full OpenAI-compatible surface: streaming, tools, and parallel tool calls are
  // all observed behaviour for agentic clients of this shape.
  opencode: Object.freeze({
    capabilities: Object.freeze([
      "chat",
      "chat.stream",
      "models.list",
      "tools",
      "tools.parallel",
      "cancel",
    ] as const),
    scopes: Object.freeze([...DEFAULT_CLIENT_SCOPES] as const),
  }),
  hermes: Object.freeze({
    capabilities: Object.freeze([
      "chat",
      "chat.stream",
      "models.list",
      "tools",
      "cancel",
    ] as const),
    scopes: Object.freeze([...DEFAULT_CLIENT_SCOPES] as const),
  }),
  antigravity: Object.freeze({
    capabilities: Object.freeze([
      "chat",
      "chat.stream",
      "models.list",
      "tools",
      "cancel",
    ] as const),
    scopes: Object.freeze([...DEFAULT_CLIENT_SCOPES] as const),
  }),
  // The conservative floor. A client BAYZ has never seen gets only what the
  // OpenAI protocol itself guarantees, so nothing is assumed on its behalf.
  "generic-openai": Object.freeze({
    capabilities: Object.freeze(["chat", "models.list", "cancel"] as const),
    scopes: Object.freeze([...DEFAULT_CLIENT_SCOPES] as const),
  }),
});

export const CLIENT_PRESETS = PRESETS;

/**
 * A `Map`, not a property read.
 *
 * `PRESETS[name]` would resolve `__proto__`, `constructor`, and `toString` through
 * the prototype chain and hand a caller something that is not a preset.
 */
const PRESET_MAP = new Map<string, ClientPreset>(Object.entries(PRESETS));

export function presetFor(name: unknown): ClientPreset {
  if (typeof name !== "string") {
    return PRESETS["generic-openai"];
  }
  return PRESET_MAP.get(name) ?? PRESETS["generic-openai"];
}

export function isClientPresetName(value: unknown): value is ClientPresetName {
  return typeof value === "string" && PRESET_MAP.has(value);
}
