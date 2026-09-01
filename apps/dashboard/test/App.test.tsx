import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { SCREENS } from "../src/Shell";
import { createTokenStore, type TokenStore } from "../src/api/token";

/**
 * Dashboard shell, and the login surface in front of it.
 *
 * Authentication decides the whole render tree, not the contents of one panel: while
 * locked, `App` returns the login surface and never mounts `Shell`. So every shell
 * assertion below needs an unlocked store — a test that renders `<App />` bare is
 * testing the login screen, which is what the first block does deliberately.
 *
 * The approved `reference/Web-Ui.html` is a Usage-only preview whose other nav buttons
 * are disabled shell elements. The product's are not: these tests pin that every nav
 * entry is real, reachable, and moves `aria-current`, because a nav button that looks
 * live and does nothing is the single most misleading thing a shell can ship.
 */

const TOKEN = "app-test-token-0123456789abcdef";

/** An unlocked store, since the shell does not exist without one. */
function unlockedStore(): TokenStore {
  const store = createTokenStore();
  store.set(TOKEN);
  return store;
}

const health = async () => ({ status: "ok" as const, version: "0.1.0", uptimeSeconds: 1 });

describe("GOAT ROUTER login surface", () => {
  it("renders the login surface instead of the dashboard shell while locked", () => {
    render(<App healthClient={health} tokenStore={createTokenStore()} />);

    expect(screen.getByLabelText(/api token/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();

    /*
     * The shell is not merely empty — it is not mounted. Each of these is a piece of
     * chrome that used to render around the token field, and none of them belongs to a
     * session that does not exist yet.
     */
    for (const entry of SCREENS) {
      expect(
        screen.queryByRole("button", { name: entry.label }),
        `${entry.label} navigation is offered before authentication`,
      ).toBeNull();
    }
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Home." })).toBeNull();
    expect(screen.queryByText("Core online")).toBeNull();
    expect(screen.queryByText(/local router/i)).toBeNull();
    expect(screen.queryByText(/flux core/i)).toBeNull();
  });

  it("carries no copy beyond what completes the login action", () => {
    const { container } = render(<App healthClient={health} tokenStore={createTokenStore()} />);

    // Every text node on the surface, normalised. Adjacent elements produce no
    // whitespace between them, hence the concatenation.
    const text = (container.textContent ?? "").replace(/\s+/g, " ").trim();
    expect(text).toBe("API tokenUnlock");

    // The lockup is the only image, and it names the product for assistive technology
    // because no shell heading exists yet to do it.
    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", "/brand/goat-router-lockup.png");
    expect(images[0]).toHaveAttribute("alt", "GOAT ROUTER");
  });

  it("mounts the shell only once a token is entered", () => {
    const store = createTokenStore();
    render(<App healthClient={health} tokenStore={store} />);

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/api token/i)).toBeNull();
  });

  it("returns to the login surface when a 401 clears the token", async () => {
    const store = unlockedStore();
    render(<App healthClient={health} tokenStore={store} />);
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();

    // What the API client does on a 401. The store notifies outside React's event
    // system, so the re-render is awaited rather than assumed to be synchronous.
    store.clear();

    expect(await screen.findByLabelText(/api token/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
  });
});

describe("GOAT ROUTER dashboard shell", () => {
  it("shows a verified Core status on the home screen", async () => {
    render(
      <App
        healthClient={async () => ({
          status: "ok",
          version: "0.1.0",
          uptimeSeconds: 42,
        })}
        tokenStore={unlockedStore()}
      />,
    );
    expect(screen.getByRole("heading", { name: "GOAT ROUTER" })).toBeInTheDocument();
    expect(await screen.findByText("Core online")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("names the product exactly once in the document, through the approved artwork", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} />);

    // One accessible product name, carried by the rail heading's hidden text node
    // rather than by an `alt` on artwork that CSS shows or hides per breakpoint.
    expect(screen.getAllByRole("heading", { name: "GOAT ROUTER" })).toHaveLength(1);

    // Every brand image in the shell is decorative, so none announces the name a second
    // time — and all of them point at the approved files, not at an invented icon.
    const brandImages = Array.from(
      document.querySelectorAll<HTMLImageElement>("img[src^='/brand/']"),
    );
    expect(brandImages.length).toBeGreaterThan(0);
    for (const image of brandImages) {
      expect(image).toHaveAttribute("alt", "");
      expect(image).toHaveAttribute("aria-hidden", "true");
      expect(image.getAttribute("src")).toMatch(
        /^\/brand\/goat-router-(lockup\.png|character\.webp)$/,
      );
    }

    // No stale BAYZ product wordmark anywhere in the chrome.
    expect(screen.queryByRole("heading", { name: "Bayz" })).toBeNull();
  });

  it("shows an actionable offline state", async () => {
    render(
      <App
        healthClient={async () => {
          throw new Error("offline");
        }}
        tokenStore={unlockedStore()}
      />,
    );
    expect(await screen.findByText("Core offline")).toBeInTheDocument();
    expect(screen.getByText("Check the GOAT ROUTER process and try again.")).toBeInTheDocument();
  });

  it("offers every screen the product actually has, and none it does not", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} />);
    for (const entry of SCREENS) {
      const button = screen.getByRole("button", { name: entry.label });
      expect(button).toBeInTheDocument();
      // The reference preview disabled these. A real one must not.
      expect(button).toBeEnabled();
    }
    // `Settings` is not a screen the product has, so it is not offered as one.
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("marks exactly the selected screen as the current page", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} />);
    const current = () =>
      screen
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-current") === "page")
        .map((button) => button.textContent);

    expect(current()).toEqual(["\u2302Home"]);

    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(current()).toEqual(["\u2307Usage"]);
  });
});

/**
 * The mobile drawer.
 *
 * The bug this covers: below 640px the rail was `display: none` and no menu existed, so
 * the only thing in the mobile header was a caption reading `<screen> / FLUX CORE V2`.
 * That looked like a two-item navigation and there was no way to change screen at all.
 *
 * jsdom applies no stylesheet, so these tests assert the *structure and behaviour* that
 * make a drawer work — one canonical list, a labelled trigger, `aria-expanded`, and
 * close-on-select. The breakpoint itself is CSS and is verified separately against the
 * built stylesheet.
 */
describe("GOAT ROUTER mobile navigation", () => {
  it("offers a labelled menu trigger only once authenticated", () => {
    const { unmount } = render(<App healthClient={health} tokenStore={createTokenStore()} />);
    expect(screen.queryByRole("button", { name: /navigation/i })).toBeNull();
    unmount();

    render(<App healthClient={health} tokenStore={unlockedStore()} />);
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });

  it("reports its state through aria-expanded rather than by appearance alone", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} />);
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // `aria-controls` must actually resolve, or the relationship is decorative.
    const controlled = trigger.getAttribute("aria-controls");
    expect(controlled).toBeTruthy();
    expect(document.getElementById(controlled!)).not.toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: "Close navigation" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("exposes every canonical screen and nothing else", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    /*
     * Derived from `SCREENS`, not from a hand-written list: a nav built from a second
     * source could drift, and this asserts the drawer and the registry are the same thing.
     * The exact-equality is the load-bearing half — an invented entry fails it.
     */
    const nav = screen.getByRole("navigation");
    const labels = Array.from(nav.querySelectorAll("button")).map(
      (button) => button.querySelector(".nav-label")?.textContent,
    );
    expect(labels).toEqual(SCREENS.map((entry) => entry.label));

    // `Status` is a panel inside Home, not a screen. It must not appear as an entry.
    expect(labels).not.toContain("Status");
    expect(labels).not.toContain("Settings");
  });

  it("navigates and closes itself when a screen is chosen", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    fireEvent.click(screen.getByRole("button", { name: "Providers" }));

    // The screen changed. `Providers`, not `Providers.` — the trailing period was an
    // affectation from the reference preview, and the copy contract now bans it.
    expect(screen.getByRole("heading", { name: "Providers" })).toBeInTheDocument();
    // ...the active marker moved with it...
    expect(screen.getByRole("button", { name: "Providers" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // ...and the drawer closed rather than staying over the screen it just opened.
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("reaches every canonical screen's real content through the drawer", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} />);

    /*
     * The functional half: each entry must open its own screen, not merely highlight.
     * Asserted on each screen's own heading, so an entry wired to the wrong screen fails.
     *
     * The headings lost their trailing periods in the copy pass, and the panel inside each
     * screen no longer restates the title — so each name matches exactly one heading,
     * which is what makes `getByRole` usable here at all.
     */
    for (const label of ["Providers", "Routes", "Proxies", "Identities", "Chat", "Home"] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(
        screen.getByRole("heading", { name: label, level: 2 }),
        `${label} did not open its screen`,
      ).toBeInTheDocument();
    }
  });

  it("closes on Escape without changing screen", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // Dismissing is not navigating: Home is still the screen.
    expect(screen.getByRole("heading", { name: "Home" })).toBeInTheDocument();
  });

  it("no longer renders the preview-only FLUX CORE V2 header caption", () => {
    render(<App healthClient={health} tokenStore={unlockedStore()} />);

    /*
     * The header caption was the entire cause of the reported bug: it read as
     * `Home / FLUX CORE V2` and was mistaken for the navigation. The rail foot still names
     * the relay track — that is a real label for the visualization, not a nav entry — so
     * this asserts on the header specifically rather than banning the string outright.
     */
    const header = document.querySelector(".mobile-head")!;
    expect(header.textContent).not.toMatch(/flux core/i);
    expect(header.querySelector(".shell-tag")).toBeNull();
  });
});
