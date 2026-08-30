import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eventDiffSourceId, ReviewPane } from "../src/components/ReviewPane";
import { api } from "../src/lib/api";
import type { TaskArtifactsPage, TerminusSseEvent } from "../src/types";

const DIFF = [
  "diff --git a/src/answer.ts b/src/answer.ts",
  "--- a/src/answer.ts",
  "+++ b/src/answer.ts",
  "@@ -1 +1 @@",
  "-export const answer = 41;",
  "+export const answer = 42;",
].join("\n");

/**
 * Reveal the artifact index.
 *
 * Changes leads with the working-tree diff now. The content-addressed list is
 * reference material behind an explicit click — it used to be what the pane
 * fell back to whenever the diff came back empty, which is how a task with real
 * edits ended up showing a column of sha256 hashes.
 */
async function browseArtifacts(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Browse artifacts" }));
}

function patchEvent(): TerminusSseEvent {
  return {
    id: "patch-1",
    event: "tool.settled",
    data: JSON.stringify({ tool: "patch", result: { patch: DIFF } }),
  };
}

describe("ReviewPane", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());
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

  test("keeps review completion explicitly local when no authoritative endpoint exists", async () => {
    render(<ReviewPane events={[patchEvent()]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    const localReview = screen.getByRole("button", { name: "Mark reviewed locally" });
    expect(localReview).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Draft change request" })).toBeDisabled();

    await userEvent.setup().click(localReview);
    expect(screen.getByRole("button", { name: "Reviewed locally" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Reviewed in this window")).toBeInTheDocument();
  });

  test("serializes pagination and deduplicates artifacts by immutable hash", async () => {
    let resolveNext: (page: Awaited<ReturnType<typeof api.listTaskArtifacts>>) => void = () => undefined;
    const list = vi.spyOn(api, "listTaskArtifacts")
      .mockResolvedValueOnce({
        task_id: "task-1",
        artifacts: [{ hash: "sha256:first", purpose: "log", media_type: "text/plain", size_bytes: 10 }],
        total: 2,
        next_cursor: "cursor-1",
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));

    render(<ReviewPane taskId="task-1" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
    await browseArtifacts();
    const loadMore = await screen.findByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);

    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Loading" })).toBeDisabled();
    resolveNext({
      task_id: "task-1",
      artifacts: [
        { hash: "sha256:first", purpose: "log", media_type: "text/plain", size_bytes: 10 },
        { hash: "sha256:second", purpose: "evidence", media_type: "text/plain", size_bytes: 20 },
      ],
      total: 2,
      next_cursor: null,
    });

    await waitFor(() => expect(screen.getByText("sha256:second")).toBeInTheDocument());
    expect(screen.getAllByText("sha256:first")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  test("makes an initial artifact inventory failure dominant and retryable", async () => {
    vi.spyOn(api, "listTaskArtifacts")
      .mockRejectedValueOnce(new Error("inventory offline"))
      .mockResolvedValueOnce({
        task_id: "task-retry",
        artifacts: [{ hash: "sha256:recovered", purpose: "log", media_type: "text/plain", size_bytes: 4 }],
        total: 1,
        next_cursor: null,
      });

    render(<ReviewPane taskId="task-retry" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
    await browseArtifacts();
    expect(await screen.findByRole("alert")).toHaveTextContent("inventory offline");
    expect(screen.queryByRole("heading", { name: "No reviewable changes yet" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry inventory" }));
    expect(await screen.findByText("sha256:recovered")).toBeInTheDocument();
  });

  test("retries a failed artifact preview without forcing the operator to reopen it", async () => {
    vi.spyOn(api, "listTaskArtifacts").mockResolvedValue({
      task_id: "task-preview-retry",
      artifacts: [{ hash: "sha256:preview-retry", purpose: "diff", media_type: "text/x-diff", size_bytes: DIFF.length }],
      total: 1,
      next_cursor: null,
    });
    vi.spyOn(api, "getArtifactText")
      .mockRejectedValueOnce(new Error("preview offline"))
      .mockResolvedValueOnce({ text: DIFF, truncated: false, totalBytes: DIFF.length });

    render(<ReviewPane taskId="task-preview-retry" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
    await browseArtifacts();
    fireEvent.click((await screen.findByText("sha256:preview-retry")).closest("button")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("preview offline");
    fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
    expect(await screen.findByRole("region", { name: "Diff viewer" })).toBeInTheDocument();
  });

  test("keys review notes by immutable evidence source and restores them after reopening", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(api, "listTaskArtifacts").mockResolvedValue({
      task_id: "task-1",
      artifacts: [
        { hash: "sha256:artifact-a", purpose: "first diff", media_type: "text/x-diff", size_bytes: DIFF.length },
        { hash: "sha256:artifact-b", purpose: "second diff", media_type: "text/x-diff", size_bytes: DIFF.length },
      ],
      total: 2,
      next_cursor: null,
    });
    vi.spyOn(api, "getArtifactText").mockResolvedValue({ text: DIFF, truncated: false, totalBytes: DIFF.length });
    const onDraftRevision = vi.fn();

    const first = render(<ReviewPane taskId="task-1" events={[]} onClose={vi.fn()} onDraftRevision={onDraftRevision} />);
    await browseArtifacts();
    fireEvent.click((await screen.findByText("sha256:artifact-a")).closest("button")!);
    await screen.findByRole("region", { name: "Diff viewer" });
    fireEvent.click(screen.getAllByRole("button", { name: "Add comment" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Comment draft" }), { target: { value: "Keep this artifact-specific note." } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Keep this artifact-specific note.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to changes overview" }));
    fireEvent.click(screen.getByText("sha256:artifact-b").closest("button")!);
    await screen.findByRole("region", { name: "Diff viewer" });
    expect(screen.queryByText("Keep this artifact-specific note.")).not.toBeInTheDocument();

    first.unmount();
    render(<ReviewPane taskId="task-1" events={[]} onClose={vi.fn()} onDraftRevision={onDraftRevision} />);
    await browseArtifacts();
    fireEvent.click((await screen.findByText("sha256:artifact-a")).closest("button")!);
    expect(await screen.findByText("Keep this artifact-specific note.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Draft change request" }));
    expect(onDraftRevision).toHaveBeenCalledWith(expect.stringContaining("immutable artifact sha256:artifact-a"));
  });

  test("assigns unique ids to same-line notes submitted in the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_725_000_000_000);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(api, "listTaskArtifacts").mockResolvedValue({
      task_id: "task-collision",
      artifacts: [{ hash: "sha256:collision", purpose: "collision diff", media_type: "text/x-diff", size_bytes: DIFF.length }],
      total: 1,
      next_cursor: null,
    });
    vi.spyOn(api, "getArtifactText").mockResolvedValue({ text: DIFF, truncated: false, totalBytes: DIFF.length });

    render(<ReviewPane taskId="task-collision" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
    await browseArtifacts();
    fireEvent.click((await screen.findByText("sha256:collision")).closest("button")!);
    await screen.findByRole("region", { name: "Diff viewer" });

    for (const body of ["First same-line note", "Second same-line note"]) {
      fireEvent.click(screen.getAllByRole("button", { name: "Add comment" })[0]!);
      fireEvent.change(screen.getByRole("textbox", { name: "Comment draft" }), { target: { value: body } });
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
      expect(await screen.findByText(body)).toBeInTheDocument();
    }

    await waitFor(() => expect(
      JSON.parse(window.localStorage.getItem("terminus-desktop.review-notes.v2.task-collision") ?? "[]"),
    ).toHaveLength(2));
    const stored = JSON.parse(window.localStorage.getItem("terminus-desktop.review-notes.v2.task-collision") ?? "[]") as Array<{ id: string }>;
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((note) => note.id)).size).toBe(2);
  });

  test("flushes notes to their original task before switching review context", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(api, "listTaskArtifacts").mockImplementation(async (taskId) => ({
      task_id: taskId,
      artifacts: [{ hash: `sha256:${taskId}`, purpose: "diff", media_type: "text/x-diff", size_bytes: DIFF.length }],
      total: 1,
      next_cursor: null,
    }));
    vi.spyOn(api, "getArtifactText").mockResolvedValue({ text: DIFF, truncated: false, totalBytes: DIFF.length });

    const view = render(<ReviewPane taskId="task-a" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
    await browseArtifacts();
    fireEvent.click((await screen.findByText("sha256:task-a")).closest("button")!);
    fireEvent.click((await screen.findAllByRole("button", { name: "Add comment" }))[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Comment draft" }), { target: { value: "Only task A" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Only task A")).toBeInTheDocument();

    view.rerender(<ReviewPane taskId="task-b" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
    await browseArtifacts();
    expect(await screen.findByText("sha256:task-b")).toBeInTheDocument();
    expect(screen.queryByText("Only task A")).not.toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem("terminus-desktop.review-notes.v2.task-a")).toContain("Only task A"));
    expect(window.localStorage.getItem("terminus-desktop.review-notes.v2.task-b") ?? "").not.toContain("Only task A");
  });

  test("preserves corrupt stored notes and exposes recovery instead of overwriting them", async () => {
    window.localStorage.setItem("terminus-desktop.review-notes.v2.task-corrupt-notes", "{");
    vi.spyOn(api, "listTaskArtifacts").mockResolvedValue({
      task_id: "task-corrupt-notes",
      artifacts: [],
      total: 0,
      next_cursor: null,
    });
    render(<ReviewPane taskId="task-corrupt-notes" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    expect(await screen.findByText(/Stored review notes could not be read/)).toBeInTheDocument();
    expect(window.localStorage.getItem("terminus-desktop.review-notes.v2.task-corrupt-notes")).toBe("{");
    expect(screen.getByRole("button", { name: "Retry storage" })).toBeInTheDocument();
  });

  test("uses authoritative event identity instead of a colliding patch fingerprint", () => {
    const prefix = ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old"];
    const firstDiff = [...prefix, "+1jpqnmr1unmxqv0foyv3w1l815d0"].join("\n");
    const secondDiff = [...prefix, "+1rkq2ev152nux803fz1m4187arba"].join("\n");
    const event = (id: string, patch: string): TerminusSseEvent => ({
      id,
      event: "tool.settled",
      data: JSON.stringify({ tool: "patch", result: { patch } }),
    });

    expect(eventDiffSourceId(event("event-first", firstDiff), 0, 0))
      .not.toBe(eventDiffSourceId(event("event-second", secondDiff), 0, 0));
  });

  test("keeps notes isolated while switching event snapshots and artifact inventory", async () => {
    const user = userEvent.setup();
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(api, "listTaskArtifacts").mockResolvedValue({
      task_id: "task-event-sources",
      artifacts: [{ hash: "sha256:log", purpose: "log", media_type: "text/plain", size_bytes: 4 }],
      total: 1,
      next_cursor: null,
    });
    const event = (id: string, patch: string): TerminusSseEvent => ({
      id,
      event: "tool.settled",
      data: JSON.stringify({ tool: "patch", result: { patch } }),
    });
    const secondDiff = DIFF.replaceAll("answer.ts", "second.ts").replace("42", "43");
    const onDraftRevision = vi.fn();
    const view = render(
      <ReviewPane
        taskId="task-event-sources"
        events={[event("event-first", DIFF)]}
        onClose={vi.fn()}
        onDraftRevision={onDraftRevision}
      />,
    );
    await screen.findByRole("region", { name: "Diff viewer" });
    fireEvent.click(screen.getAllByRole("button", { name: "Add comment" })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Comment draft" }), {
      target: { value: "Only for the first snapshot." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Only for the first snapshot.")).toBeInTheDocument();

    view.rerender(
      <ReviewPane
        taskId="task-event-sources"
        events={[event("event-first", DIFF), event("event-second", secondDiff)]}
        onClose={vi.fn()}
        onDraftRevision={onDraftRevision}
      />,
    );
    expect(screen.getByText("src/second.ts")).toBeInTheDocument();
    expect(screen.queryByText("Only for the first snapshot.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draft change request" })).toBeDisabled();

    await user.click(screen.getByRole("combobox", { name: "Change source" }));
    await user.click(await screen.findByRole("option", { name: /event event-first/ }));
    expect(await screen.findByText("Only for the first snapshot.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browse artifacts" }));
    expect(await screen.findByText("sha256:log")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draft change request" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review event diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Draft change request" }));
    expect(onDraftRevision).toHaveBeenCalledWith(expect.stringContaining("event event-first"));
  });

});

/**
 * The workspace diff.
 *
 * Review used to be reconstructed from patch text embedded in tool events —
 * what the agent *said* it changed, and only while those events were still in
 * the retained window. Reopening a finished task showed "No reviewable
 * changes yet" for a task that had rewritten half a file. The control plane
 * has always exposed GET /v1/tasks/:id/diff, which runs git in the workspace
 * through the kernel; nothing in the client ever called it.
 */
describe("ReviewPane — working tree", () => {
  const WORKSPACE_DIFF = [
    "diff --git a/src/worktree.ts b/src/worktree.ts",
    "--- a/src/worktree.ts",
    "+++ b/src/worktree.ts",
    "@@ -1 +1 @@",
    "-const committed = true;",
    "+const committed = false;",
  ].join("\n");

  function diffResponse(overrides: Partial<Awaited<ReturnType<typeof api.getTaskDiff>>> = {}): Awaited<ReturnType<typeof api.getTaskDiff>> {
    return {
      task_id: "task-1",
      workspace_id: "workspace-1",
      git_available: true,
      diff: WORKSPACE_DIFF,
      diff_truncated: false,
      untracked_files: [],
      exit_code: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(api, "listTaskArtifacts").mockResolvedValue({
      task_id: "task-1", artifacts: [], total: 0, next_cursor: null,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  test("shows what the workspace actually holds", async () => {
    vi.spyOn(api, "getTaskDiff").mockResolvedValue(diffResponse());

    render(<ReviewPane taskId="task-1" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    expect(await screen.findByText("src/worktree.ts")).toBeInTheDocument();
  });

  test("prefers it over patch text scraped from events", async () => {
    vi.spyOn(api, "getTaskDiff").mockResolvedValue(diffResponse());

    render(<ReviewPane taskId="task-1" events={[patchEvent()]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    // Both are offered, but the workspace is the one shown first: it is the
    // ground truth, and an event patch may have been superseded since.
    expect(await screen.findByText("src/worktree.ts")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Change source" })).toHaveTextContent(/Working tree/);
  });

  test("still offers the event patches beside it", async () => {
    vi.spyOn(api, "getTaskDiff").mockResolvedValue(diffResponse());
    const user = userEvent.setup();
    render(<ReviewPane taskId="task-1" events={[patchEvent()]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
    await user.click(await screen.findByRole("combobox", { name: "Change source" }));
    await user.click(await screen.findByRole("option", { name: /event patch-1/ }));

    expect(await screen.findByText("src/answer.ts")).toBeInTheDocument();
  });

  test("says the workspace is clean rather than claiming no evidence exists", async () => {
    vi.spyOn(api, "getTaskDiff").mockResolvedValue(diffResponse({ diff: "" }));

    render(<ReviewPane taskId="task-1" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    // "No evidence" and "nothing changed" are different claims, and this is
    // the second one.
    expect(await screen.findByRole("heading", { name: "No changes in the working tree" })).toBeInTheDocument();
  });

  test("says so when the workspace is not a git repository", async () => {
    vi.spyOn(api, "getTaskDiff").mockResolvedValue(diffResponse({ diff: "", git_available: false }));

    render(<ReviewPane taskId="task-1" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    // Silence here reads as "the agent changed nothing", which is a lie.
    expect(await screen.findByText(/not a git repository/i)).toBeInTheDocument();
  });

  // The observed defect: ⌘D on a task that had really edited a file opened
  // onto a column of sha256 artifact hashes. The pane fell back to the
  // artifact index whenever it had no parsed diff files, and an artifact index
  // is not a review.
  test("never opens onto the artifact index in place of a diff", async () => {
    vi.spyOn(api, "getTaskDiff").mockResolvedValue(diffResponse({ diff: "" }));
    vi.spyOn(api, "listTaskArtifacts").mockResolvedValue({
      task_id: "task-1",
      artifacts: [{ hash: "sha256:opaque", purpose: "log", media_type: "text/plain", size_bytes: 12 }],
      total: 1,
      next_cursor: null,
    });

    render(<ReviewPane taskId="task-1" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "No changes in the working tree" })).toBeInTheDocument();
    expect(screen.queryByText("sha256:opaque")).not.toBeInTheDocument();
    // Still reachable, just not the default.
    await browseArtifacts();
    expect(await screen.findByText("sha256:opaque")).toBeInTheDocument();
  });

  test("shows the working-tree diff even when artifacts exist", async () => {
    vi.spyOn(api, "getTaskDiff").mockResolvedValue(diffResponse());
    vi.spyOn(api, "listTaskArtifacts").mockResolvedValue({
      task_id: "task-1",
      artifacts: [{ hash: "sha256:opaque", purpose: "log", media_type: "text/plain", size_bytes: 12 }],
      total: 1,
      next_cursor: null,
    });

    render(<ReviewPane taskId="task-1" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    expect(await screen.findByText("src/worktree.ts")).toBeInTheDocument();
    expect(screen.queryByText("sha256:opaque")).not.toBeInTheDocument();
  });

  test("reports a truncated diff instead of presenting a partial one as whole", async () => {
    vi.spyOn(api, "getTaskDiff").mockResolvedValue(diffResponse({ diff_truncated: true }));

    render(<ReviewPane taskId="task-1" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    expect(await screen.findByText(/too large to show in full/i)).toBeInTheDocument();
  });

  test("keeps event evidence usable when the workspace diff fails", async () => {
    vi.spyOn(api, "getTaskDiff").mockRejectedValue(new Error("kernel unavailable"));

    render(<ReviewPane taskId="task-1" events={[patchEvent()]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    expect(await screen.findByText("src/answer.ts")).toBeInTheDocument();
  });

  test("does not ask for a diff when there is no task", () => {
    const getTaskDiff = vi.spyOn(api, "getTaskDiff").mockResolvedValue(diffResponse());

    render(<ReviewPane events={[patchEvent()]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);

    expect(getTaskDiff).not.toHaveBeenCalled();
  });
});
