import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import { StatusPanel } from "../src/panels/StatusPanel";
import type { RuntimeStatus } from "../src/api/types";

const STATUS: RuntimeStatus = {
  schemaVersion: 4,
  journalMode: "wal",
  driver: "node:sqlite",
  keyProvider: "environment",
  keyId: "kek_c8459bb637e8a8108b3e145d28c96e68",
  counts: { providers: 2, proxies: 1, routes: 3 },
};

describe("StatusPanel", () => {
  it("renders the operational facts the Core reported", async () => {
    render(<StatusPanel load={async () => STATUS} />);

    expect(await screen.findByText("4")).toBeInTheDocument();
    expect(screen.getByText("wal")).toBeInTheDocument();
    expect(screen.getByText("node:sqlite")).toBeInTheDocument();
    expect(screen.getByText("environment")).toBeInTheDocument();
    expect(screen.getByTestId("count-providers")).toHaveTextContent("2");
    expect(screen.getByTestId("count-proxies")).toHaveTextContent("1");
    expect(screen.getByTestId("count-routes")).toHaveTextContent("3");
  });

  it("shows the key fingerprint, which is not key material", async () => {
    render(<StatusPanel load={async () => STATUS} />);
    expect(await screen.findByText(STATUS.keyId)).toBeInTheDocument();
  });

  it("shows the envelope code and message on failure", async () => {
    render(
      <StatusPanel
        load={async () => {
          throw new ApiError(503, "storage_unavailable", "local storage could not be initialized");
        }}
      />,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("storage_unavailable");
    expect(alert).toHaveTextContent("local storage could not be initialized");
  });

  it("reports a transport failure without a status code", async () => {
    render(
      <StatusPanel
        load={async () => {
          throw new ApiError(0, "network_error", "The Bayz Core could not be reached");
        }}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("network_error");
  });

  it("renders no field the panel does not know about, even if the API sends one", async () => {
    const hostile = {
      ...STATUS,
      apiToken: "leaked-token-value",
      credential: "sk-leaked-credential",
      password: "hunter2-leaked",
    } as unknown as RuntimeStatus;

    const { container } = render(<StatusPanel load={async () => hostile} />);
    await screen.findByText("4");

    // Only the known keys are read, so an unexpected field cannot reach the DOM.
    expect(container.innerHTML).not.toContain("leaked-token-value");
    expect(container.innerHTML).not.toContain("sk-leaked-credential");
    expect(container.innerHTML).not.toContain("hunter2-leaked");
  });

  it("renders hostile string values as text, never as markup", async () => {
    const hostile: RuntimeStatus = {
      ...STATUS,
      driver: "<img src=x onerror=\"window.__xss = true\">",
      journalMode: "<script>window.__xss = true</script>",
    };

    const { container } = render(<StatusPanel load={async () => hostile} />);
    await screen.findByText(hostile.driver);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as Record<string, unknown>).__xss).toBeUndefined();
  });

  it("shows a loading state before the first response", () => {
    render(<StatusPanel load={() => new Promise(() => {})} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
