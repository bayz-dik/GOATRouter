import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { IdentitiesPanel } from "../src/panels/IdentitiesPanel";
import type { IdentityView } from "../src/api/types";

const KEY = "a".repeat(64);
const ROTATED = "b".repeat(64);

function identity(overrides: Partial<IdentityView> = {}): IdentityView {
  return {
    id: "opencode",
    displayName: "OpenCode",
    scopes: ["chat.completions", "models.read"],
    preset: "opencode",
    revoked: false,
    expiresAt: undefined,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    lastUsedAt: undefined,
    ...overrides,
  };
}

function api(overrides: Partial<Parameters<typeof IdentitiesPanel>[0]["api"]> = {}) {
  return {
    listIdentities: vi.fn(async () => [identity()]),
    createIdentity: vi.fn(async () => ({ identity: identity(), key: KEY })),
    updateIdentity: vi.fn(async () => identity()),
    revokeIdentity: vi.fn(async () => undefined),
    rotateIdentityKey: vi.fn(async () => ({ identity: identity(), key: ROTATED })),
    ...overrides,
  };
}

describe("IdentitiesPanel", () => {
  it("lists id, name, scopes, revoked state, and last use", async () => {
    render(
      <IdentitiesPanel
        api={api({
          listIdentities: vi.fn(async () => [
            identity({ lastUsedAt: "2026-08-27T01:02:03.000Z" }),
            identity({ id: "hermes", displayName: "Hermes", revoked: true }),
          ]),
        })}
      />,
    );

    expect(await screen.findByText("opencode")).toBeInTheDocument();
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByTestId("scopes-opencode")).toHaveTextContent("chat.completions");
    expect(screen.getByTestId("scopes-opencode")).toHaveTextContent("models.read");
    expect(screen.getByTestId("state-opencode")).toHaveTextContent(/active/i);
    expect(screen.getByTestId("state-hermes")).toHaveTextContent(/revoked/i);
    expect(screen.getByTestId("last-used-opencode")).toHaveTextContent("2026-08-27");
  });

  it("reports an identity that has never been used rather than showing a fake date", async () => {
    render(<IdentitiesPanel api={api()} />);
    expect(await screen.findByTestId("last-used-opencode")).toHaveTextContent(/never/i);
  });

  it("shows a created key exactly once with an explicit warning", async () => {
    const client = api();
    render(<IdentitiesPanel api={client} />);
    await screen.findByText("opencode");

    fireEvent.change(screen.getByLabelText("Identity id"), {
      target: { value: "hermes" },
    });
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Hermes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create identity" }));

    const reveal = await screen.findByTestId("new-key");
    expect(reveal).toHaveTextContent(KEY);
    // The operator must be told it will not be shown again, or they will assume
    // they can come back for it.
    expect(screen.getByTestId("new-key-notice")).toHaveTextContent(/only once/i);
  });

  it("removes the key from the DOM after acknowledgement", async () => {
    render(<IdentitiesPanel api={api()} />);
    await screen.findByText("opencode");

    fireEvent.change(screen.getByLabelText("Identity id"), { target: { value: "hermes" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "H" } });
    fireEvent.click(screen.getByRole("button", { name: "Create identity" }));
    await screen.findByTestId("new-key");

    fireEvent.click(screen.getByRole("button", { name: /stored it/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("new-key")).not.toBeInTheDocument();
    });
    // Not merely hidden: absent from the rendered markup entirely.
    expect(document.body.innerHTML).not.toContain(KEY);
  });

  it("uses no clipboard API, keeping the CSP clean", async () => {
    // A clipboard write would need no CSP exception, but `navigator.clipboard` is
    // unavailable over plain HTTP in most browsers, so a copy button would silently
    // do nothing on a loopback dashboard. Showing the key as selectable text works.
    render(<IdentitiesPanel api={api()} />);
    await screen.findByText("opencode");
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();
  });

  it("shows a rotated key once", async () => {
    const client = api();
    render(<IdentitiesPanel api={client} />);
    await screen.findByText("opencode");

    fireEvent.click(screen.getByRole("button", { name: "Rotate key for opencode" }));
    const reveal = await screen.findByTestId("new-key");
    expect(reveal).toHaveTextContent(ROTATED);
    expect(client.rotateIdentityKey).toHaveBeenCalledWith("opencode");

    fireEvent.click(screen.getByRole("button", { name: /stored it/i }));
    await waitFor(() => {
      expect(document.body.innerHTML).not.toContain(ROTATED);
    });
  });

  it("requires confirmation before revoking", async () => {
    const client = api();
    render(<IdentitiesPanel api={client} />);
    await screen.findByText("opencode");

    fireEvent.click(screen.getByRole("button", { name: "Revoke opencode" }));
    expect(client.revokeIdentity).not.toHaveBeenCalled();
    // Revocation immediately breaks a working client. A single misplaced click
    // should not do that.
    expect(screen.getByTestId("confirm-revoke-opencode")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm revoke opencode" }));
    await waitFor(() => {
      expect(client.revokeIdentity).toHaveBeenCalledWith("opencode");
    });
  });

  it("can cancel a revocation", async () => {
    const client = api();
    render(<IdentitiesPanel api={client} />);
    await screen.findByText("opencode");

    fireEvent.click(screen.getByRole("button", { name: "Revoke opencode" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel revoke opencode" }));
    await waitFor(() => {
      expect(screen.queryByTestId("confirm-revoke-opencode")).not.toBeInTheDocument();
    });
    expect(client.revokeIdentity).not.toHaveBeenCalled();
  });

  it("does not offer revoke or rotate for an already revoked identity", async () => {
    render(
      <IdentitiesPanel
        api={api({
          listIdentities: vi.fn(async () => [identity({ revoked: true })]),
        })}
      />,
    );
    await screen.findByText("opencode");
    // Rotating a revoked identity is refused by the API; offering the button would
    // invite an error the operator cannot act on.
    expect(
      screen.queryByRole("button", { name: "Rotate key for opencode" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke opencode" })).not.toBeInTheDocument();
  });

  it("seeds scopes from a preset and stays editable", async () => {
    const client = api();
    render(<IdentitiesPanel api={client} />);
    await screen.findByText("opencode");

    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "generic-openai" } });
    const chat = screen.getByLabelText("chat.completions") as HTMLInputElement;
    const models = screen.getByLabelText("models.read") as HTMLInputElement;
    expect(chat.checked).toBe(true);
    expect(models.checked).toBe(true);

    // Editable after seeding: a preset is a starting point, not a constraint.
    fireEvent.click(models);
    expect((screen.getByLabelText("models.read") as HTMLInputElement).checked).toBe(false);

    fireEvent.change(screen.getByLabelText("Identity id"), { target: { value: "generic" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "G" } });
    fireEvent.click(screen.getByRole("button", { name: "Create identity" }));

    await waitFor(() => {
      expect(client.createIdentity).toHaveBeenCalledWith({
        id: "generic",
        displayName: "G",
        scopes: ["chat.completions"],
        preset: "generic-openai",
      });
    });
  });

  it("refuses to create an identity with no scopes", async () => {
    const client = api();
    render(<IdentitiesPanel api={client} />);
    await screen.findByText("opencode");

    fireEvent.click(screen.getByLabelText("chat.completions"));
    fireEvent.click(screen.getByLabelText("models.read"));
    fireEvent.change(screen.getByLabelText("Identity id"), { target: { value: "empty" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "E" } });
    fireEvent.click(screen.getByRole("button", { name: "Create identity" }));

    expect(client.createIdentity).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/scope/i);
  });

  it("warns before granting admin", async () => {
    render(<IdentitiesPanel api={api()} />);
    await screen.findByText("opencode");

    fireEvent.click(screen.getByLabelText("admin"));
    // `admin` is every scope at once, including minting further identities. The
    // operator should see that before they click create.
    expect(await screen.findByTestId("admin-warning")).toHaveTextContent(/every/i);
  });

  it("renders a hostile display name as inert text", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    render(
      <IdentitiesPanel
        api={api({
          listIdentities: vi.fn(async () => [identity({ displayName: hostile })]),
        })}
      />,
    );
    expect(await screen.findByText(hostile)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("surfaces an API failure using the envelope", async () => {
    render(
      <IdentitiesPanel
        api={api({
          listIdentities: vi.fn(async () => {
            throw new ApiError(403, "forbidden", "This credential lacks the required scope: admin");
          }),
        })}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("forbidden");
    expect(alert).toHaveTextContent("admin");
  });

  it("renders nothing matching a credential or password field name", async () => {
    render(
      <IdentitiesPanel
        api={api({
          listIdentities: vi.fn(async () => [identity({ lastUsedAt: "2026-08-27T00:00:00.000Z" })]),
        })}
      />,
    );
    await screen.findByText("opencode");
    const markup = document.body.innerHTML.toLowerCase();
    for (const forbidden of ["credential", "password", "secret"]) {
      expect(markup).not.toContain(forbidden);
    }
  });

  it("shows no key-shaped value in the steady-state list", async () => {
    render(<IdentitiesPanel api={api()} />);
    await screen.findByText("opencode");
    expect(document.body.innerHTML).not.toMatch(/[0-9a-f]{64}/);
  });
});
