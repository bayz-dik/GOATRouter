import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";

describe("Bayz dashboard foundation", () => {
  it("shows a verified Core status", async () => {
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
});
