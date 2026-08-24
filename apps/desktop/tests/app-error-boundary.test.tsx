import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { AppErrorBoundary } from "../src/components/AppErrorBoundary";

function BrokenSurface(): JSX.Element {
  throw new Error("render fixture failed");
}

describe("AppErrorBoundary", () => {
  test("replaces a crashed renderer tree with an actionable recovery surface", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <BrokenSurface />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "The interface stopped unexpectedly" })).toBeInTheDocument();
    expect(screen.getByText("render fixture failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy error" })).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
