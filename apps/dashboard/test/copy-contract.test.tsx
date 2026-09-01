import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { SCREENS } from "../src/Shell";
import { createTokenStore, type TokenStore } from "../src/api/token";
import type { ApiClient } from "../src/api/client";
import { FluxCore } from "../src/flux/FluxCore";
import { UsageScreen } from "../src/usage/UsageScreen";

/**
 * The copy contract: no purpose, no text.
 *
 * These are behaviour tests over the rendered DOM, not screenshots and not source greps —
 * a string is only a problem if a user can read it, and the DOM is where that is decided.
 * A source scan would also fail on the comments that explain *why* each phrase was
 * removed, which would make the comments unwriteable.
 *
 * Each banned phrase is listed with the reason it is banned, so a future reader can tell a
 * deliberate exclusion from an accident.
 */

const TOKEN = "copy-test-token-0123456789abcdef";

function unlockedStore(): TokenStore {
  const store = createTokenStore();
  store.set(TOKEN);
  return store;
}

const health = async () => ({ status: "ok" as const, version: "0.1.0", uptimeSeconds: 1 });

/** A client whose every method resolves empty, so a screen renders without network. */
function stubClient(): ApiClient {
  const empty = vi.fn(async () => []);
  return {
    getStatus: vi.fn(async () => ({
      schemaVersion: 11,
      journalMode: "wal",
      driver: "node:sqlite",
      keyProvider: "secure-file",
      keyId: "kek_test",
      counts: { providers: 0, proxies: 0, routes: 0 },
    })),
    listProviders: empty,
    listProxies: empty,
    listRoutes: empty,
    listIdentities: empty,
    listUsageRequests: empty,
    listUsageProviders: empty,
    /*
     * Chat is a screen like any other, so it is walked by the copy sweep — and the sweep
     * mounts the *real* `ChatPanel`, which calls `listModels()` on mount. A stub without
     * it threw `api.listModels is not a function` inside an effect, which React surfaces
     * as an unhandled error rather than a failed assertion, so the sweep reported a copy
     * failure for a missing stub method. Present here so the screen actually renders.
     */
    listModels: vi.fn(async () => []),
    chat: vi.fn(async () => ({
      content: "",
      model: "",
      providerId: "",
      routeId: "",
      attempts: 1,
    })),
    getUsageSummary: vi.fn(async () => ({
      period: "today",
      totalRequests: 0,
      okRequests: 0,
      failedRequests: 0,
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
      tokenReports: 0,
      averageLatencyMs: null,
      costAvailable: false,
      costReason: "no pricing table",
      retention: { requests: 0 },
    })),
  } as unknown as ApiClient;
}

/**
 * Phrases that must not reach a user, each with its reason.
 *
 * `RegExp` rather than substring so word boundaries are respected: banning the bare string
 * "LIVE" would also fail on the legitimate "Live telemetry" source label, and banning
 * "SIM" would fail on "similar". The point is to ban the *gimmick*, not the letters.
 */
const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bFLUX\s*CORE\b/i, "product jargon for the visualization"],
  [/\bRELAY\s+TRACK\b/i, "product jargon for the visualization"],
  [/\bDIRECT\s+ROUTE\b/i, "shouty jargon; the routing mode is real data, say it plainly"],
  [/\bCOMBO\s+ROUTING\b/i, "shouty jargon"],
  [/\bFAILOVER\s+SEQUENCE\b/i, "shouty jargon"],
  [/\b01\s*\/\s*SOURCE\b/i, "decorative legend caption"],
  [/\b02\s*\/\s*HANDOFF\b/i, "decorative legend caption"],
  [/\b03\s*\/\s*IMPACT\b/i, "decorative legend caption"],
  [/\bBRAIDED\s+TRAFFIC\b/i, "decorative legend caption"],
  [/\bPACKET\s+INTO\s+CORE\b/i, "decorative legend caption"],
  [/\bNETWORK\s+LOAD\b/i, "jargon; it is a load figure"],
  [/\bDRILL\s+ACTIVE\b/i, "shouty transient state"],
  [/\bAWAITING\s+CORE\b/i, "filler where a value is simply not known yet"],
  [/\bNOT\s+REPORTED\b/, "shouty; sentence case carries the same fact"],
  [/\bNODES\b/, "jargon for providers"],
  [/\bDEMO\s+DATA\b/i, "the reference preview's caption; there is no demo path"],
];

/** The product name is GOAT ROUTER. Stale BAYZ branding must not be user-visible. */
const STALE_BRAND = /\bBAYZ\b/i;

/** Every text node a user can read, normalised. */
function visibleText(root: HTMLElement): string {
  return (root.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Accessible names too, not just visible text.
 *
 * A gimmick phrase hidden in an `aria-label` is still user-facing — it is what a screen
 * reader user is told. The first pass of this suite checked `textContent` only, which
 * missed the visualization's own `aria-label`.
 */
function spokenText(root: HTMLElement): string {
  return Array.from(root.querySelectorAll("[aria-label],[title]"))
    .map((el) => `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("dashboard copy contract — no purpose, no text", () => {
  it("carries no gimmick copy on any authenticated screen", async () => {
    for (const entry of SCREENS) {
      const { container, unmount } = render(
        <App
          healthClient={health}
          tokenStore={unlockedStore()}
          apiClient={stubClient()}
          initialScreen={entry.id}
        />,
      );
      const text = `${visibleText(container)} ${spokenText(container)}`;
      for (const [pattern, reason] of BANNED) {
        expect(
          pattern.test(text),
          `${entry.label} screen renders banned copy ${pattern} (${reason})`,
        ).toBe(false);
      }
      expect(
        STALE_BRAND.test(text),
        `${entry.label} screen renders stale BAYZ product branding`,
      ).toBe(false);
      unmount();
    }
  }, 30_000);

  it("carries no gimmick copy in the visualization itself", () => {
    // Rendered directly, because the stage is the densest source of the removed jargon
    // and mounting it through Usage would depend on telemetry arriving first.
    const { container } = render(<FluxCore />);
    const text = `${visibleText(container)} ${spokenText(container)}`;
    for (const [pattern, reason] of BANNED) {
      expect(pattern.test(text), `visualization renders ${pattern} (${reason})`).toBe(false);
    }
    expect(STALE_BRAND.test(text), "visualization renders stale BAYZ branding").toBe(false);
  });

  it("names the Usage screen simply", async () => {
    render(<UsageScreen api={stubClient() as never} />);
    /*
     * "Usage", not "Usage." and not under a decorative kicker. The trailing period was an
     * affectation carried from the reference preview, and a kicker above a one-word title
     * is a caption that says less than the title it captions.
     */
    const heading = await screen.findByRole("heading", { name: "Usage", level: 1 });
    expect(heading.textContent).toBe("Usage");
    expect(screen.queryByText("Request performance")).toBeNull();
  });

  it("titles every screen without the decorative trailing period", () => {
    for (const [screenId, title] of [
      ["home", "Home"],
      ["providers", "Providers"],
      ["routes", "Routes"],
      ["proxies", "Proxies"],
      ["identities", "Identities"],
      ["chat", "Chat"],
    ] as const) {
      const { unmount } = render(
        <App
          healthClient={health}
          tokenStore={unlockedStore()}
          apiClient={stubClient()}
          initialScreen={screenId}
        />,
      );
      expect(
        screen.getByRole("heading", { name: title }),
        `${title} is not titled plainly`,
      ).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: `${title}.` })).toBeNull();
      unmount();
    }
  }, 30_000);

  it("leaves the login surface untouched", () => {
    const { container } = render(
      <App healthClient={health} tokenStore={createTokenStore()} apiClient={stubClient()} />,
    );
    /*
     * The gate's copy was already reduced to what completes the login action. This pins
     * that the cleanup did not "tidy" it further, and that it names the product correctly.
     *
     * Concatenated with no space: adjacent elements produce no whitespace between their
     * text nodes, so the label and the button read as one string here. `App.test.tsx`
     * asserts the same value for the same reason.
     */
    expect(visibleText(container)).toBe("API tokenUnlock");
    const image = container.querySelector("img")!;
    expect(image.getAttribute("alt")).toBe("GOAT ROUTER");
  });
});

describe("dashboard copy contract — the shell", () => {
  it("keeps the rail foot to the endpoint it is there to report", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} apiClient={stubClient()} />);
    const foot = document.querySelector(".side-foot")!;
    const text = visibleText(foot as HTMLElement);
    // The endpoint is the whole purpose of the foot; the visualization's product name was
    // never a fact about the router.
    expect(text).toMatch(/\/v1/);
    expect(text).not.toMatch(/FLUX/i);
    expect(text).not.toMatch(/RELAY/i);
    expect(text).not.toMatch(/\bBAYZ\b/i);
  });

  it("still reaches every canonical screen after the cleanup", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} apiClient={stubClient()} />);
    // The copy pass must not have removed a nav entry along with a label.
    const nav = screen.getByRole("navigation");
    const labels = Array.from(nav.querySelectorAll("button")).map(
      (button) => button.querySelector(".nav-label")?.textContent,
    );
    expect(labels).toEqual(["Home", "Usage", "Providers", "Routes", "Proxies", "Identities", "Chat"]);
  });
});
