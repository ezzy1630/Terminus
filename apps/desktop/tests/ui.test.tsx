import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { Button } from "../src/ui/Button";
import { Dialog } from "../src/ui/Dialog";
import { TooltipLayer } from "../src/ui/Tooltip";

describe("shared UI layer", () => {
  test("labels dialogs and closes them with Escape", async () => {
    const user = userEvent.setup();
    function DialogHarness(): JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Loading mission ledger"
            description="The active workspace remains unchanged."
            footer={<Button onClick={() => setOpen(false)}>Close</Button>}
          >
            Loading canonical task data.
          </Dialog>
          {!open ? <span>Dialog closed</span> : null}
        </>
      );
    }

    render(<DialogHarness />);

    expect(screen.getByRole("dialog", { name: "Loading mission ledger" })).toHaveAccessibleDescription(
      "The active workspace remains unchanged.",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Dialog closed")).toBeVisible();
  });

  test("shows source-owned tooltips to keyboard users", async () => {
    const user = userEvent.setup();
    render(
      <>
        <TooltipLayer />
        <Button data-tooltip="Open project">Project</Button>
      </>,
    );

    const button = screen.getByRole("button", { name: "Project" });
    expect(button).not.toHaveAttribute("title");
    expect(button).toHaveAttribute("data-tooltip", "Open project");

    await user.tab();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Open project");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
