import { describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DiffViewer, parseUnifiedDiff } from "../src/components/DiffViewer";

const DIFF = [
  "diff --git a/src/answer.ts b/src/answer.ts",
  "--- a/src/answer.ts",
  "+++ b/src/answer.ts",
  "@@ -1 +1 @@",
  "-export const answer = 41;",
  "+export const answer = 42;",
].join("\n");

function mockDiffLayout(width = 800): () => void {
  const widthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(width);
  const heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const height = this.hasAttribute("data-index")
      ? (this.querySelector("[data-testid='split-comment-thread']") ? 120 : 20)
      : 600;
    return new DOMRect(0, 0, width, height);
  });
  return () => {
    rectSpy.mockRestore();
    heightSpy.mockRestore();
    widthSpy.mockRestore();
  };
}

describe("DiffViewer decision controls", () => {
  test("does not offer local-only accept, reject, restore, or decision status", () => {
    render(<DiffViewer files={parseUnifiedDiff(DIFF)} />);

    expect(screen.queryByRole("button", { name: /Accept hunk/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reject hunk/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restore hunk/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Accepted")).not.toBeInTheDocument();
    expect(screen.queryByText("Rejected")).not.toBeInTheDocument();
  });

  test("moves DOM focus when keyboard navigation reaches a virtualized off-screen change", async () => {
    const restoreLayout = mockDiffLayout();
    const removed = Array.from({ length: 40 }, (_, index) => `-old ${index + 1}`);
    const added = Array.from({ length: 40 }, (_, index) => `+new ${index + 1}`);
    const largeDiff = [
      "diff --git a/src/large.ts b/src/large.ts",
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -1,40 +1,40 @@",
      ...removed,
      ...added,
    ].join("\n");
    try {
      render(<DiffViewer files={parseUnifiedDiff(largeDiff)} autoFocus />);

      const viewer = screen.getByRole("region", { name: "Diff viewer" });
      expect(viewer).toContainElement(document.activeElement as HTMLElement);
      const minimap = screen.getByRole("slider", { name: "Diff minimap" });
      minimap.focus();
      fireEvent.keyDown(minimap, { key: "End" });
      expect(minimap).toHaveAttribute("aria-valuenow", "81");

      const first = screen.getByLabelText("Removed; old line 1; no new line; old 1");
      first.focus();
      for (let index = 0; index < 30; index += 1) fireEvent.keyDown(window, { key: "j" });

      await waitFor(() => expect(screen.getByLabelText("Removed; old line 31; no new line; old 31")).toHaveFocus());
    } finally {
      restoreLayout();
    }
  });

  test("pages every loaded row with semantic coordinates in accessibility mode", async () => {
    const restoreLayout = mockDiffLayout();
    const removed = Array.from({ length: 240 }, (_, index) => `-old ${index + 1}`);
    const added = Array.from({ length: 240 }, (_, index) => `+new ${index + 1}`);
    const largeDiff = [
      "diff --git a/src/large.ts b/src/large.ts",
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -1,240 +1,240 @@",
      ...removed,
      ...added,
    ].join("\n");
    try {
      render(<DiffViewer files={parseUnifiedDiff(largeDiff)} />);

      const windowed = screen.getByRole("list", { name: /Windowed diff for src\/large\.ts \(481 rows\)/ });
      const mounted = windowed.querySelector("[role='listitem']");
      expect(mounted).toHaveAttribute("aria-setsize", "481");

      fireEvent.click(screen.getByRole("button", { name: "Browse lines" }));
      const firstPage = await screen.findByRole("list", { name: /All loaded diff rows for src\/large\.ts \(1-200 of 481\)/ });
      const rows = firstPage.querySelectorAll(":scope > [role='listitem']");
      expect(rows).toHaveLength(200);
      expect(rows[0]).toHaveAttribute("aria-posinset", "1");
      expect(rows[199]).toHaveAttribute("aria-posinset", "200");
      expect(rows[1]).toHaveAttribute("aria-setsize", "481");
      expect(within(rows[1] as HTMLElement).getByRole("group", {
        name: "Removed; old line 1; no new line; old 1",
      })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Next diff rows" }));
      const secondPage = await screen.findByRole("list", { name: /All loaded diff rows for src\/large\.ts \(201-400 of 481\)/ });
      const nextRows = secondPage.querySelectorAll(":scope > [role='listitem']");
      expect(nextRows).toHaveLength(200);
      expect(nextRows[0]).toHaveAttribute("aria-posinset", "201");
      expect(nextRows[199]).toHaveAttribute("aria-posinset", "400");
    } finally {
      restoreLayout();
    }
  });

  test("restores line-action focus after cancelling or submitting a comment", async () => {
    const restoreLayout = mockDiffLayout();
    const onAddComment = vi.fn();
    try {
      render(
        <DiffViewer
          files={parseUnifiedDiff(DIFF)}
          initialViewMode="unified"
          onAddComment={onAddComment}
        />,
      );

      const trigger = screen.getAllByRole("button", { name: "Add comment" })[0];
      if (!trigger) throw new Error("Expected a comment trigger for the removed line");
      act(() => trigger.focus());
      fireEvent.click(trigger);
      expect(screen.getByRole("textbox", { name: "Comment draft" })).toHaveFocus();

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(trigger).toHaveFocus());

      fireEvent.click(trigger);
      fireEvent.change(screen.getByRole("textbox", { name: "Comment draft" }), {
        target: { value: "Use the exact evidence source." },
      });
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));

      expect(onAddComment).toHaveBeenCalledWith("src/answer.ts", 1, "old", "Use the exact evidence source.");
      await waitFor(() => expect(trigger).toHaveFocus());
    } finally {
      restoreLayout();
    }
  });

  test("renders split-mode review notes below the paired code row", async () => {
    const restoreLayout = mockDiffLayout(900);
    try {
      render(<DiffViewer files={parseUnifiedDiff(DIFF)} initialViewMode="split" />);
      await waitFor(() => expect(screen.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "true"));

      const trigger = screen.getAllByRole("button", { name: "Add comment" })[0];
      if (!trigger) throw new Error("Expected a split comment trigger for the old side");
      act(() => trigger.focus());
      fireEvent.click(trigger);

      const thread = screen.getByTestId("split-comment-thread");
      expect(thread.previousElementSibling).toHaveAttribute("data-testid", "split-code-row");
      expect(screen.getByRole("textbox", { name: "Comment draft" }).closest("[aria-label='Old side review notes']")).not.toBeNull();
    } finally {
      restoreLayout();
    }
  });
});
