import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenGate } from "../src/api/TokenGate";
import { createTokenStore } from "../src/api/token";

const TOKEN = "operator-token-0123456789abcdef";

describe("in-memory token store", () => {
  it("starts empty and holds a token only in memory", () => {
    const store = createTokenStore();
    expect(store.get()).toBeUndefined();
    expect(store.isSet()).toBe(false);

    store.set(TOKEN);
    expect(store.get()).toBe(TOKEN);
    expect(store.isSet()).toBe(true);
  });

  it("writes to no browser storage of any kind", () => {
    const localSet = vi.spyOn(Storage.prototype, "setItem");
    const store = createTokenStore();
    store.set(TOKEN);

    expect(localSet).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    localSet.mockRestore();
  });

  it("clears on demand so a rotated token cannot linger", () => {
    const store = createTokenStore();
    store.set(TOKEN);
    store.clear();
    expect(store.get()).toBeUndefined();
    expect(store.isSet()).toBe(false);
  });

  it("refuses a blank token rather than holding an unusable value", () => {
    const store = createTokenStore();
    expect(store.set("")).toBe(false);
    expect(store.set("   ")).toBe(false);
    expect(store.isSet()).toBe(false);
    expect(store.set(`  ${TOKEN}  `)).toBe(true);
    expect(store.get()).toBe(TOKEN);
  });

  it("notifies subscribers when the token changes", () => {
    const store = createTokenStore();
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.isSet()));

    store.set(TOKEN);
    store.clear();
    unsubscribe();
    store.set(TOKEN);

    expect(seen).toEqual([true, false]);
  });
});

describe("TokenGate", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("asks for a token before rendering the operator surface", () => {
    const store = createTokenStore();
    render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    expect(screen.getByLabelText(/api token/i)).toBeInTheDocument();
    expect(screen.queryByText("Operator surface")).not.toBeInTheDocument();
  });

  it("uses a password input that browsers will not autofill or remember", () => {
    const store = createTokenStore();
    render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    const input = screen.getByLabelText(/api token/i);
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
  });

  it("reveals the operator surface once a token is entered", async () => {
    const store = createTokenStore();
    render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));

    expect(await screen.findByText("Operator surface")).toBeInTheDocument();
    expect(store.get()).toBe(TOKEN);
  });

  it("does not leave the token in the DOM after unlocking", async () => {
    const store = createTokenStore();
    const { container } = render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    await screen.findByText("Operator surface");

    expect(container.innerHTML).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("refuses an empty submission with a message and stays locked", async () => {
    const store = createTokenStore();
    render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Operator surface")).not.toBeInTheDocument();
    expect(store.isSet()).toBe(false);
  });

  it("returns to the gate when the token is cleared by a 401", async () => {
    const store = createTokenStore();
    render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    await screen.findByText("Operator surface");

    // What the API client does on a 401.
    store.clear();

    await waitFor(() => {
      expect(screen.getByLabelText(/api token/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("Operator surface")).not.toBeInTheDocument();
  });

  it("carries no copy on the login surface beyond the login action", () => {
    /*
     * Replaces an assertion that the gate *explains* the token is not remembered. That
     * explanation was removed on purpose: it is true, it is documented in the README, and
     * it does not help anyone complete a login. This asserts the absence instead, so the
     * copy cannot drift back in one well-meant commit at a time.
     */
    const store = createTokenStore();
    const { container } = render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    expect((container.textContent ?? "").replace(/\s+/g, " ").trim()).toBe("API tokenUnlock");

    for (const banned of [
      /not stored/i,
      /memory only/i,
      /local router/i,
      /operator access/i,
      /core online/i,
      /secure/i,
      /welcome/i,
      /powered by/i,
    ]) {
      expect(screen.queryByText(banned), `login copy matched ${banned}`).toBeNull();
    }
  });

  it("clears the input value from component state after submitting", async () => {
    const store = createTokenStore();
    render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    const input = screen.getByLabelText(/api token/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    await screen.findByText("Operator surface");

    store.clear();
    await waitFor(() => {
      const again = screen.getByLabelText(/api token/i) as HTMLInputElement;
      expect(again.value).toBe("");
    });
  });

  it("offers a lock action that clears the token", async () => {
    const store = createTokenStore();
    render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    await screen.findByText("Operator surface");

    fireEvent.click(screen.getByRole("button", { name: /lock/i }));
    expect(store.isSet()).toBe(false);
    expect(await screen.findByLabelText(/api token/i)).toBeInTheDocument();
  });

  /*
   * The GOAT ROUTER identity on the gate.
   *
   * Pinned because this is the screen the brand integration exists for, and because a
   * refactor that dropped an `src` would still leave a perfectly working login form —
   * the failure would be invisible to every other test in this file.
   */
  it("shows the complete approved lockup as the single login brand asset", () => {
    const store = createTokenStore();
    const { container } = render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    const images = Array.from(container.querySelectorAll("img"));
    /*
     * Exactly one image. The lockup is one brand unit — character, halo, separator and
     * wordmark in their delivered relationship — so a second `<img>` here would mean
     * someone had split it back into a hero and a wordmark.
     */
    expect(images).toHaveLength(1);
    expect(images[0]).toHaveAttribute("src", "/brand/goat-router-lockup.png");
    // It names the product: no shell heading exists on this surface to do it.
    expect(images[0]).toHaveAttribute("alt", "GOAT ROUTER");
  });

  it("uses the lockup as delivered — original ratio, contained, never cropped", () => {
    const store = createTokenStore();
    const { container } = render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    const image = container.querySelector("img")!;
    // The file's own intrinsic size, so the ratio a browser reserves is the real one.
    expect(image.getAttribute("width")).toBe("1672");
    expect(image.getAttribute("height")).toBe("941");
    // No inline filter/blend/opacity/transform: "as delivered" means unmodified.
    expect(image.getAttribute("style")).toBeNull();
  });

  it("does not render the artwork once unlocked, so it cannot reach the Usage screen", async () => {
    const store = createTokenStore();
    const { container } = render(
      <TokenGate store={store}>
        <p>Operator surface</p>
      </TokenGate>,
    );

    fireEvent.change(screen.getByLabelText(/api token/i), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: /unlock/i }));
    await screen.findByText("Operator surface");

    // The gate is the only place the character appears. Flux Core owns the Usage scene.
    expect(container.querySelector("img")).toBeNull();
  });
});
