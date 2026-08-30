import type { ReactNode } from "react";

/**
 * The BAYZ dashboard shell — ported from the approved `reference/Web-Ui.html`.
 *
 * Two differences from the reference, both because the reference is a Usage-only
 * preview rather than a product page set:
 *
 *  1. Its Home / Routes / Providers / Settings buttons are disabled preview elements.
 *     Here every nav entry is real and reaches a working screen, so `disabled` is gone
 *     and `aria-current="page"` moves with the selection.
 *  2. `Settings` is replaced by the screens that actually exist — Proxies, Identities,
 *     and Chat — rather than kept as a label for a screen Bayz does not have. An
 *     inert nav entry is a promise the product does not keep.
 *
 * The brand mark, the type scale, the 84px / 224px rail breakpoints, and the mobile
 * header are the approved system, unchanged.
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
  const current = SCREENS.find((entry) => entry.id === screen);

  return (
    <div className="app">
      <aside className="side-nav" aria-label="BAYZ navigation">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          {/*
            The only heading named "Bayz" in the document: the mobile header repeats the
            wordmark as plain text so assistive technology is not offered the same
            landmark twice.
          */}
          <h1 className="brand-word">Bayz</h1>
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
                onClick={() => onSelect(entry.id)}
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
          LOCAL ROUTER
          <br />
          {endpoint}
          <br />
          RELAY TRACK / FLUX CORE V2
        </div>
      </aside>

      <div className="app-body">
        <header className="mobile-head">
          <div className="mobile-brand">
            <div className="brand-mark" aria-hidden="true" />
            <span className="brand-word">Bayz</span>
          </div>
          <span className="shell-tag">{`${current?.label ?? "BAYZ"} / FLUX CORE V2`}</span>
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
