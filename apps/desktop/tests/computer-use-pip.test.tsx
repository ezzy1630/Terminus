import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComputerUsePiP } from "../src/components/ComputerUsePiP";

describe("ComputerUsePiP trust boundary", () => {
  afterEach(cleanup);

  test("shows an explicit unavailable state without local capture or control theater", () => {
    render(<ComputerUsePiP />);

    expect(screen.getByRole("region", { name: "Computer-use availability" })).toBeInTheDocument();
    expect(screen.getByText("Trusted preview unavailable")).toBeInTheDocument();
    expect(screen.getByText(/will not capture this Mac's display/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /take over|stop session|hand back/i })).toBeNull();
    expect(document.querySelector("video")).toBeNull();
  });

  test("keeps hide and expand as view-only preferences", async () => {
    const user = userEvent.setup();
    const onHide = vi.fn();
    const onToggleExpanded = vi.fn();
    render(<ComputerUsePiP onHide={onHide} onToggleExpanded={onToggleExpanded} />);

    await user.click(screen.getByRole("button", { name: "Expand computer-use status" }));
    expect(onToggleExpanded).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Hide computer-use availability" }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  test("restores a hidden availability surface without claiming an active session", async () => {
    const onShow = vi.fn();
    const onToggleExpanded = vi.fn();
    render(<ComputerUsePiP hidden onShow={onShow} onToggleExpanded={onToggleExpanded} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Show computer-use availability" }));
    expect(onToggleExpanded).toHaveBeenCalledWith(false);
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Computer use unavailable")).toBeInTheDocument();
  });
});
