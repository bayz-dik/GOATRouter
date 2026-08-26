import { describe, expect, it } from "vitest";
import { providerIdentity, shortId, initialsOf, ICON_KEYS } from "../src/flux/identity";
import type { FluxProvider } from "../src/flux/types";

function provider(overrides: Partial<FluxProvider> = {}): FluxProvider {
  return {
    id: "p1",
    displayName: "OPENROUTER",
    state: "active",
    sharePercent: 20,
    ...overrides,
  };
}

describe("provider identity", () => {
  it("keeps the approved provider names recognizable", () => {
    for (const name of ["OPENROUTER", "GEMINI", "CODEX", "TABITOKEN", "CUSTOM"]) {
      const identity = providerIdentity(provider({ displayName: name }), []);
      expect(identity.displayName).toBe(name);
    }
  });

  it("resolves a known icon key to a local mark", () => {
    const identity = providerIdentity(
      provider({ displayName: "GEMINI", iconKey: "gemini" }),
      [],
    );
    expect(ICON_KEYS).toContain(identity.iconKey);
    expect(identity.iconKey).toBe("gemini");
  });

  it("falls back to a deterministic monochrome mark for an unknown icon key", () => {
    const identity = providerIdentity(
      provider({ id: "custom-1", displayName: "CUSTOM / TOKYO", iconKey: "not-a-known-key" }),
      [],
    );
    // An unrecognized key never reaches rendering; the generic mark is used.
    expect(ICON_KEYS).toContain(identity.iconKey);
    expect(identity.iconKey).toBe("generic");
    expect(identity.initials).toBe("CT");
  });

  it("never treats provider-supplied markup as an icon", () => {
    for (const hostile of [
      '<svg onload="window.__iconXss = true"></svg>',
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "https://evil.example.com/logo.svg",
      "../../etc/passwd",
    ]) {
      const identity = providerIdentity(
        provider({ iconKey: hostile as never, displayName: "CUSTOM" }),
        [],
      );
      expect(identity.iconKey).toBe("generic");
      expect(ICON_KEYS).toContain(identity.iconKey);
    }
  });

  it("derives initials from a display name without trusting it as markup", () => {
    expect(initialsOf("OPENROUTER")).toBe("OP");
    expect(initialsOf("CUSTOM / TOKYO")).toBe("CT");
    expect(initialsOf("a b c d")).toBe("AB");
    expect(initialsOf("<script>x</script>")).toBe("SX");
    expect(initialsOf("")).toBe("PV");
    expect(initialsOf("   ")).toBe("PV");
  });

  it("produces a stable non-secret short id", () => {
    const first = shortId("provider-tokyo");
    const second = shortId("provider-tokyo");
    expect(first).toBe(second);
    expect(first).toMatch(/^PVD-[0-9A-F]{4}$/);
    expect(shortId("provider-backup")).not.toBe(first);
  });

  it("derives the short id only from the id, never from a secret", () => {
    // Same id, different everything else: the short id must not change, which
    // proves nothing else feeds into it.
    const a = providerIdentity(provider({ id: "same", displayName: "ALPHA" }), []);
    const b = providerIdentity(provider({ id: "same", displayName: "BETA" }), []);
    expect(a.shortId).toBe(b.shortId);
  });

  it("disambiguates custom providers that share a display name", () => {
    const list: FluxProvider[] = [
      provider({ id: "cust-a", displayName: "CUSTOM" }),
      provider({ id: "cust-b", displayName: "CUSTOM" }),
      provider({ id: "cust-c", displayName: "CUSTOM" }),
      provider({ id: "unique", displayName: "GEMINI" }),
    ];

    const a = providerIdentity(list[0]!, list);
    const b = providerIdentity(list[1]!, list);
    const c = providerIdentity(list[2]!, list);
    const unique = providerIdentity(list[3]!, list);

    expect(a.requiresShortId).toBe(true);
    expect(b.requiresShortId).toBe(true);
    expect(unique.requiresShortId).toBe(false);

    // Every duplicate resolves to a distinct, safe, human-readable label.
    const labels = [a.uniqueLabel, b.uniqueLabel, c.uniqueLabel];
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) {
      expect(label).toMatch(/^CUSTOM — PVD-[0-9A-F]{4}$/);
    }
    expect(unique.uniqueLabel).toBe("GEMINI");
  });

  it("keeps a hostile display name as inert text in the label", () => {
    const hostile = '<img src=x onerror="window.__labelXss = true">';
    const identity = providerIdentity(provider({ displayName: hostile }), []);
    // The value passes through unchanged as *text*; escaping is React's job and is
    // asserted in the component tests. What matters here is that no sanitizing
    // rewrite silently changes an operator's label into something else.
    expect(identity.displayName).toBe(hostile);
    expect(identity.iconKey).toBe("generic");
  });

  it("truncates an absurdly long display name for layout without losing identity", () => {
    const identity = providerIdentity(
      provider({ id: "long", displayName: "X".repeat(500) }),
      [],
    );
    expect(identity.compactLabel.length).toBeLessThanOrEqual(24);
    expect(identity.shortId).toMatch(/^PVD-[0-9A-F]{4}$/);
  });

  it("carries no secret-shaped field", () => {
    const identity = providerIdentity(provider(), []);
    for (const key of Object.keys(identity)) {
      expect(key.toLowerCase()).not.toMatch(
        /credential|password|token|secret|authorization|apikey/,
      );
    }
  });
});
