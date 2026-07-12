import { describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReviewPane } from "../src/components/ReviewPane";
import type { TerminusSseEvent } from "../src/types";

const DIFF = [
  "diff --git a/src/answer.ts b/src/answer.ts",
  "--- a/src/answer.ts",
  "+++ b/src/answer.ts",
  "@@ -1 +1 @@",
  "-export const answer = 41;",
  "+export const answer = 42;",
].join("\n");

function patchEvent(): TerminusSseEvent {
  return {
    id: "patch-1",
    event: "tool.settled",
    data: JSON.stringify({ tool: "patch", result: { patch: DIFF } }),
  };
}

describe("ReviewPane", () => {
  test("keeps the review surface empty until actual patch evidence exists", () => {
    render(<ReviewPane events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "No reviewable changes yet" })).toBeInTheDocument();
  });

  test("renders a parsed changed file from a patch tool event", () => {
    render(<ReviewPane events={[patchEvent()]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
    expect(screen.getByText("src/answer.ts")).toBeInTheDocument();
  });

  test("closes from the review header", () => {
    const onClose = vi.fn();
    render(<ReviewPane events={[patchEvent()]} onClose={onClose} onDraftRevision={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Close changes" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
