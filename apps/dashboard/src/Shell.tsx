import { useCallback, useEffect, useId, useState, type ReactNode } from "react";

/**
 * The GOAT ROUTER dashboard shell — ported from the approved `reference/Web-Ui.html`.
 *
 * Differences from the reference, all because the reference is a desktop-only Usage
 * preview rather than a product page set:
 *
 *  1. Its Home / Routes / Providers / Settings buttons are disabled preview elements.
 *     Here every nav entry is real and reaches a working screen, so `disabled` is gone
 *     and `aria-current="page"` moves with the selection.
 *  2. `Settings` is replaced by the screens that actually exist — Proxies, Identities,
 *     and Chat — rather than kept as a label for a screen GOAT ROUTER does not have. An
 *     inert nav entry is a promise the product does not keep.
 *  3. The reference's geometric skewed-bar mark and its text wordmark are replaced by
 *     the approved GOAT ROUTER lockup. The type scale and the 84px / 224px rail
 *     breakpoints are unchanged.
 *  4. **The reference has no mobile navigation at all** — `mobile-nav` appears zero times
 *     in it, and it ships no menu trigger. Its mobile header carried a caption
 *     (`<screen> / FLUX CORE V2`) and nothing else, so below 640px the product had no way
 *     to change screen: the rail was `display: none` and the caption read like a
 *     two-item menu. The caption is gone and the rail is now a real drawer on mobile.
 *
 * **One nav, not two.** The drawer is not a second list — `.side-nav` *is* the drawer
 * below 640px (a fixed overlay panel) and the static rail from 640px up. A second set of
 * buttons for mobile could drift from this one, and duplicated labels would make every
 * `getByRole("button", { name })` in the suite ambiguous. `SCREENS` is mapped exactly
 * once.
 */

export const SCREENS = [
  { id: "home", label: "Home", icon: "\u2302" },
  { id: "usage", label: "Usage", icon: "\u2307" },
  { id: "providers", label: "Providers", icon: "\u25E6" },
  { id: "routes", label: "Routes", icon: "\u2197" },
  { id: "proxies", label: "Proxies", icon: "\u21C4" },
  { id: "identities", label: "Identities", icon: "\u26BF" },
  { id: "chat", label: "Chat", icon: "\u2338" },
] as const;

export type ScreenId = (typeof SCREENS)[number]["id"];

export type ShellProps = {
  screen: ScreenId;
  onSelect: (screen: ScreenId) => void;
  /** Where the local Core is reachable, shown in the rail foot. */
  endpoint: string;
  children: ReactNode;
};

export function Shell({ screen, onSelect, endpoint, children }: ShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navId = useId();

  /*
   * Escape closes the drawer. Bound only while it is open, so the shell installs no
   * listener during the overwhelming majority of its lifetime.
   */
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const select = useCallback(
    (id: ScreenId) => {
      onSelect(id);
      // Selecting always closes: on desktop the drawer is not open in the first place,
      // so this is a no-op there rather than a branch.
      setMenuOpen(false);
    },
    [onSelect],
  );

  return (
    <div className="app" data-menu-open={menuOpen ? "" : undefined}>
      {/*
        The backdrop exists only while the drawer is open. Below 640px it covers the
        screen so a tap outside the panel dismisses it; from 640px the drawer is never
        open, so it is never rendered.
      */}
      {menuOpen && (
        <div
          className="nav-backdrop"
          onClick={() => setMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className="side-nav"
        id={navId}
        aria-label="GOAT ROUTER navigation"
        data-open={menuOpen ? "" : undefined}
      >
        <div className="brand">
          {/*
            The name is a real text node, hidden visually but not from assistive
            technology; the artwork is decorative (`alt=""` + `aria-hidden`), because the
            mobile header repeats it and two `alt`s would announce the product twice.
          */}
          <h1 className="goat-brand">
            <span className="goat-visually-hidden">GOAT ROUTER</span>
            <img
              className="goat-brand-lockup"
              src="/brand/goat-router-lockup.png"
              alt=""
              aria-hidden="true"
              width={1672}
              height={941}
              decoding="async"
            />
          </h1>
        </div>
        <nav className="nav-stack">
          {SCREENS.map((entry) => {
            const active = entry.id === screen;
            return (
              <button
                key={entry.id}
                className={`nav-button${active ? " active" : ""}`}
                type="button"
                {...(active ? { "aria-current": "page" as const } : {})}
                onClick={() => select(entry.id)}
              >
                <span className="nav-icon" aria-hidden="true">
                  {entry.icon}
                </span>
                <span className="nav-label">{entry.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="side-foot">
          {/*
            The endpoint, which is the only fact this slot ever carried. It used to sit under
            a `LOCAL ROUTER` heading and above `RELAY TRACK / FLUX CORE V2` — a label for
            something the operator can already see, and a product name for an animation.
          */}
          {endpoint}
        </div>
      </aside>

      <div className="app-body">
        <header className="mobile-head">
          <div className="mobile-brand">
            <img
              className="goat-brand-lockup"
              src="/brand/goat-router-lockup.png"
              alt=""
              aria-hidden="true"
              width={1672}
              height={941}
              decoding="async"
            />
          </div>
          {/*
            The menu trigger. Its accessible name states what it does rather than being an
            unlabelled glyph, and `aria-expanded` carries the state so the control is not
            merely decorative to a screen reader.
          */}
          <button
            className="nav-toggle"
            type="button"
            aria-expanded={menuOpen}
            aria-controls={navId}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="nav-toggle-bars" aria-hidden="true" />
            <span className="goat-visually-hidden">
              {menuOpen ? "Close navigation" : "Open navigation"}
            </span>
          </button>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
