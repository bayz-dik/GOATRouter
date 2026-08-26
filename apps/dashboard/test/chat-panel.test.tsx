import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { ChatPanel } from "../src/panels/ChatPanel";

const PROMPT = "chat panel prompt";

function api(overrides: Partial<Parameters<typeof ChatPanel>[0]["api"]> = {}) {
  return {
    listModels: vi.fn(async () => ["gpt-4o", "gpt-4o-mini"]),
    chat: vi.fn(async () => ({
      content: "The answer.",
      finishReason: "stop",
      model: "gpt-4o",
      routeId: "r1",
      providerId: "p1",
      proxyId: undefined,
    })),
    ...overrides,
  };
}

describe("ChatPanel", () => {
  it("offers the models the Core advertises", async () => {
    render(<ChatPanel api={api()} />);
    expect(await screen.findByRole("option", { name: "gpt-4o" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "gpt-4o-mini" })).toBeInTheDocument();
  });

  it("sends one message and renders the reply with its routing headers", async () => {
    const client = api();
    render(<ChatPanel api={client} />);
    await screen.findByRole("option", { name: "gpt-4o" });

    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: PROMPT } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(await screen.findByText("The answer.")).toBeInTheDocument();
    expect(client.chat).toHaveBeenCalledWith({
      model: "gpt-4o",
      messages: [{ role: "user", content: PROMPT }],
    });

    const meta = screen.getByTestId("chat-routing");
    expect(meta).toHaveTextContent("r1");
    expect(meta).toHaveTextContent("p1");
  });

  it("reports the proxy when one was used", async () => {
    const client = api({
      chat: vi.fn(async () => ({
        content: "Through the tunnel.",
        finishReason: "stop",
        model: "gpt-4o",
        routeId: "r1",
        providerId: "p1",
        proxyId: "x1",
      })),
    });
    render(<ChatPanel api={client} />);
    await screen.findByRole("option", { name: "gpt-4o" });

    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: PROMPT } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await screen.findByText("Through the tunnel.");
    expect(screen.getByTestId("chat-routing")).toHaveTextContent("x1");
  });

  it("refuses to send an empty message", async () => {
    const client = api();
    render(<ChatPanel api={client} />);
    await screen.findByRole("option", { name: "gpt-4o" });

    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(client.chat).not.toHaveBeenCalled();
  });

  it("renders a hostile completion as text, never as markup", async () => {
    const client = api({
      chat: vi.fn(async () => ({
        content: '<img src=x onerror="window.__xssChat = true">',
        finishReason: "stop",
        model: "gpt-4o",
        routeId: "r1",
        providerId: "p1",
        proxyId: undefined,
      })),
    });
    const { container } = render(<ChatPanel api={client} />);
    await screen.findByRole("option", { name: "gpt-4o" });

    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: PROMPT } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await screen.findByText('<img src=x onerror="window.__xssChat = true">');
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xssChat).toBeUndefined();
  });

  it("renders a hostile routing header as text", async () => {
    const client = api({
      chat: vi.fn(async () => ({
        content: "ok",
        finishReason: "stop",
        model: "gpt-4o",
        routeId: '<script>window.__xssHeader = true</script>',
        providerId: "p1",
        proxyId: undefined,
      })),
    });
    const { container } = render(<ChatPanel api={client} />);
    await screen.findByRole("option", { name: "gpt-4o" });

    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: PROMPT } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await screen.findByText("ok");
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xssHeader).toBeUndefined();
  });

  it("shows the envelope code when the Core refuses", async () => {
    const client = api({
      chat: vi.fn(async () => {
        throw new ApiError(400, "no_route", "no enabled route matches the requested model");
      }),
    });
    render(<ChatPanel api={client} />);
    await screen.findByRole("option", { name: "gpt-4o" });

    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: PROMPT } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("no_route");
  });

  it("offers no streaming control, because the API rejects streaming", async () => {
    const { container } = render(<ChatPanel api={api()} />);
    await screen.findByRole("option", { name: "gpt-4o" });

    expect(container.innerHTML.toLowerCase()).not.toContain("stream");
    expect(screen.queryByLabelText(/stream/i)).toBeNull();
  });

  it("keeps no transcript across a remount", async () => {
    const client = api();
    const first = render(<ChatPanel api={client} />);
    await screen.findByRole("option", { name: "gpt-4o" });

    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: PROMPT } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    await screen.findByText("The answer.");

    first.unmount();
    render(<ChatPanel api={client} />);
    await screen.findByRole("option", { name: "gpt-4o" });

    // Nothing is persisted, so a fresh mount starts blank.
    expect(screen.queryByText("The answer.")).toBeNull();
    expect(screen.queryByText(PROMPT)).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("shows a model load failure using the envelope", async () => {
    render(
      <ChatPanel
        api={api({
          listModels: vi.fn(async () => {
            throw new ApiError(401, "unauthorized", "A valid API token is required");
          }),
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("unauthorized");
  });
});
