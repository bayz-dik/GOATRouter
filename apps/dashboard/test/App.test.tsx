import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { SCREENS } from "../src/Shell";

/**
 * Dashboard shell.
 *
 * The approved `reference/Web-Ui.html` is a Usage-only preview whose other nav buttons
 * are disabled shell elements. The product's are not: these tests pin that every nav
 * entry is real, reachable, and moves `aria-current`, because a nav button that looks
 * live and does nothing is the single most misleading thing a shell can ship.
 */

describe("Bayz dashboard shell", () => {
  it("shows a verified Core status on the home screen", async () => {
    render(
      <App
        healthClient={async () => ({
          status: "ok",
          version: "0.1.0",
          uptimeSeconds: 42,
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Bayz" })).toBeInTheDocument();
    expect(await screen.findByText("Core online")).toBeInTheDocument();
    expect(screen.getByText("v0.1.0")).toBeInTheDocument();
  });

  it("shows an actionable offline state", async () => {
    render(<App healthClient={async () => { throw new Error("offline"); }} />);
    expect(await screen.findByText("Core offline")).toBeInTheDocument();
    expect(screen.getByText("Check the Bayz process and try again.")).toBeInTheDocument();
  });

  it("offers every screen the product actually has, and none it does not", () => {
    render(<App healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })} />);
    for (const entry of SCREENS) {
      const button = screen.getByRole("button", { name: entry.label });
      expect(button).toBeInTheDocument();
      // The reference preview disabled these. A real one must not.
      expect(button).toBeEnabled();
    }
    // `Settings` is not a screen Bayz has, so it is not offered as one.
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("marks exactly the selected screen as the current page", () => {
    render(<App healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })} />);
    const current = () =>
      screen
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-current") === "page")
        .map((button) => button.textContent);

    expect(current()).toEqual(["\u2302Home"]);

    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(current()).toEqual(["\u2307Usage"]);
  });

  it("navigates to a screen that is gated rather than rendering it unlocked", () => {
    render(<App healthClient={async () => ({ status: "ok", version: "0.1.0", uptimeSeconds: 1 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Providers" }));

    expect(screen.getByRole("heading", { name: "Providers." })).toBeInTheDocument();
    // The screen exists; its contents still require the token.
    expect(screen.getByLabelText(/api token/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Providers", level: 2 })).toBeNull();
  });
});
