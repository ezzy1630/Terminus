import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComputerUsePiP } from "../src/components/ComputerUsePiP";

describe("ComputerUsePiP interactions", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  test("restores a hidden preview from its activity badge", async () => {
    const onShow = vi.fn();
    const onToggleExpanded = vi.fn();
    render(<ComputerUsePiP hidden onShow={onShow} onToggleExpanded={onToggleExpanded} />);

    await userEvent.setup().click(screen.getByRole("button", { name: "Show computer-use preview" }));
    expect(onToggleExpanded).toHaveBeenCalledWith(false);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  test("wires pause, expand, hide, stop, take-over, drag, and resize controls", async () => {
    const user = userEvent.setup();
    const onToggleExpanded = vi.fn();
    const onHide = vi.fn();
    const onStop = vi.fn();
    const onTakeOver = vi.fn();
    render(
      <ComputerUsePiP
        initialPosition={{ x: 100, y: 100 }}
        initialSize={{ width: 360, height: 240 }}
        onToggleExpanded={onToggleExpanded}
        onHide={onHide}
        onStop={onStop}
        onTakeOver={onTakeOver}
      />,
    );

    const region = screen.getByRole("region", { name: "Computer-use preview" });
    expect(region).toHaveStyle({ left: "100px", top: "100px", width: "360px", height: "240px" });

    fireEvent.pointerDown(screen.getByTestId("computer-use-drag-handle"), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 150 });
    await waitFor(() => expect(region).toHaveStyle({ left: "140px", top: "150px" }));
    fireEvent.pointerUp(window);

    fireEvent.pointerDown(screen.getByTestId("computer-use-resize-handle"), { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 30 });
    await waitFor(() => expect(region).toHaveStyle({ width: "400px", height: "270px" }));
    fireEvent.pointerUp(window);

    await user.click(screen.getByRole("button", { name: "Pause preview" }));
    expect(screen.getByRole("button", { name: "Resume preview" })).toBeInTheDocument();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Expand to main canvas" }));
    expect(onToggleExpanded).toHaveBeenCalledWith(true);
    await user.click(screen.getByRole("button", { name: "Hide preview" }));
    expect(onHide).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Stop session" }));
    expect(onStop).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Take over control" }));
    expect(onTakeOver).toHaveBeenCalledWith("user-controlled");
    expect(screen.getByRole("button", { name: "Return control to agent" })).toBeInTheDocument();
  });
});
