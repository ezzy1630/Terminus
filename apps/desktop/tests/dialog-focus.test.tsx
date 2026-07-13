import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { useDialogFocus } from "../src/hooks/use-dialog-focus";

function Modal({ onClose }: { onClose: () => void }): JSX.Element {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose);
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Test dialog">
      <button type="button">First control</button>
      <button type="button">Last control</button>
    </div>
  );
}

function Harness(): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      {open ? <Modal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

describe("useDialogFocus", () => {
  test("focuses the modal, wraps Tab, closes on Escape, and restores its trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole("button", { name: "Open dialog" });
    await user.click(trigger);
    const first = screen.getByRole("button", { name: "First control" });
    const last = screen.getByRole("button", { name: "Last control" });
    await waitFor(() => expect(first).toHaveFocus());

    last.focus();
    await user.tab();
    expect(first).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Test dialog" })).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
