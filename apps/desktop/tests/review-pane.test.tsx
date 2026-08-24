import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArtifactDiffInspectorView } from "../src/components/Cockpit/ArtifactDiffInspectorView";
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
    fireEvent.click((await screen.findByText("sha256:artifact-a")).closest("button")!);
    expect(await screen.findByText("Keep this artifact-specific note.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to composer" }));
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
    fireEvent.click((await screen.findByText("sha256:task-a")).closest("button")!);
    fireEvent.click((await screen.findAllByRole("button", { name: "Add comment" }))[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: "Comment draft" }), { target: { value: "Only task A" } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Only task A")).toBeInTheDocument();

    view.rerender(<ReviewPane taskId="task-b" events={[]} onClose={vi.fn()} onDraftRevision={vi.fn()} />);
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
    expect(screen.queryByRole("button", { name: "Add to composer" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Event diff snapshot" }));
    await user.click(await screen.findByRole("option", { name: /event event-first/ }));
    expect(await screen.findByText("Only for the first snapshot.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browse artifacts" }));
    expect(await screen.findByText("sha256:log")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to composer" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review event diff" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to composer" }));
    expect(onDraftRevision).toHaveBeenCalledWith(expect.stringContaining("event event-first"));
  });

  test("renders a truncated diff artifact only as a bounded raw preview", async () => {
    vi.spyOn(api, "listTaskArtifacts").mockResolvedValue({
      task_id: "task-1",
      artifacts: [{ hash: "sha256:partial", purpose: "partial diff", media_type: "text/x-diff", size_bytes: DIFF.length * 2 }],
      total: 1,
      next_cursor: null,
    });
    vi.spyOn(api, "getArtifactText").mockResolvedValue({ text: DIFF, truncated: true, totalBytes: DIFF.length * 2 });

    render(<ArtifactDiffInspectorView selectedTaskId="task-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /partial diff/ }));

    expect(await screen.findByText(/Preview stopped at/)).toHaveTextContent("sha256:partial");
    expect(document.querySelector("pre")?.textContent).toBe(DIFF);
    expect(screen.queryByRole("region", { name: "Diff viewer" })).not.toBeInTheDocument();
  });

  test("invalidates an in-flight continuation when the artifact snapshot refreshes", async () => {
    const basePage: TaskArtifactsPage = {
      task_id: "task-refresh",
      artifacts: [{ hash: "sha256:base", purpose: "base", media_type: "text/plain", size_bytes: 4 }],
      total: 2,
      next_cursor: "cursor-1",
    };
    let firstPageCalls = 0;
    let continuationCalls = 0;
    let resolveRefresh: (page: typeof basePage) => void = () => undefined;
    let resolveOldContinuation: (page: typeof basePage) => void = () => undefined;
    let resolveNewContinuation: (page: typeof basePage) => void = () => undefined;
    vi.spyOn(api, "listTaskArtifacts").mockImplementation((_taskId, cursor) => {
      if (cursor === null || cursor === undefined) {
        firstPageCalls += 1;
        if (firstPageCalls === 1) return Promise.resolve(basePage);
        return new Promise((resolve) => { resolveRefresh = resolve; });
      }
      continuationCalls += 1;
      return new Promise((resolve) => {
        if (continuationCalls === 1) resolveOldContinuation = resolve;
        else resolveNewContinuation = resolve;
      });
    });

    render(<ArtifactDiffInspectorView selectedTaskId="task-refresh" />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more artifacts" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh snapshot" }));
    expect(screen.getByRole("button", { name: "Refresh snapshot" })).toBeDisabled();

    await act(async () => {
      resolveRefresh(basePage);
      resolveOldContinuation({
        ...basePage,
        artifacts: [{ hash: "sha256:stale", purpose: "stale", media_type: "text/plain", size_bytes: 5 }],
        next_cursor: null,
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Load more artifacts" })).toBeEnabled());
    expect(screen.queryByText("stale")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more artifacts" }));
    await act(async () => {
      resolveNewContinuation({
        ...basePage,
        artifacts: [{ hash: "sha256:fresh", purpose: "fresh", media_type: "text/plain", size_bytes: 5 }],
        next_cursor: null,
      });
    });
    expect(await screen.findByText("fresh")).toBeInTheDocument();
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
  });
});
