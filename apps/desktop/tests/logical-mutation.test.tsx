import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApprovalCard } from "../src/components/ApprovalCard";
import { MaterialQuestionCard } from "../src/components/MaterialQuestionCard";
import { api, TerminusApiError } from "../src/lib/api";
import { arpV2 } from "../src/lib/api-v2";
import {
  isDefinitiveMutationFailure,
  MutationJournalAdmissionError,
  PendingMutationConflictError,
  useLogicalMutation,
} from "../src/hooks/use-logical-mutation";
import type { ApprovalDecision } from "../src/types";
import type { MaterialQuestionSnapshot } from "../src/types/v2";

const decisions: ApprovalDecision[] = ["allow_once", "deny_once"];

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => cleanup());

describe("logical mutation journal", () => {
  test("a definitive rejection can be abandoned and replaced with changed input", () => {
    const first = renderHook(() => useLogicalMutation("test-definitive-rejection"));
    const firstKey = first.result.current.keyFor(JSON.stringify({ choice: "old" }));

    act(() => first.result.current.abandon(firstKey));
    expect(() => first.result.current.keyFor(JSON.stringify({ choice: "new" }))).not.toThrow();

    first.unmount();
  });

  test("an ambiguous failure remains protected across a renderer restart", () => {
    const first = renderHook(() => useLogicalMutation("test-ambiguous-retry"));
    const key = first.result.current.keyFor(JSON.stringify({ choice: "old" }));
    first.unmount();

    const restarted = renderHook(() => useLogicalMutation("test-ambiguous-retry"));
    expect(restarted.result.current.keyFor(JSON.stringify({ choice: "old" }))).toBe(key);
    expect(() => restarted.result.current.keyFor(JSON.stringify({ choice: "new" }))).toThrow(
      PendingMutationConflictError,
    );
    restarted.unmount();
  });

  test("blocks corrupt and unreadable durable journals", () => {
    window.localStorage.setItem("terminus.pending-mutation.v1.test-corrupt", "{");
    const corrupt = renderHook(() => useLogicalMutation("test-corrupt"));
    expect(() => corrupt.result.current.keyFor("same action")).toThrow(MutationJournalAdmissionError);
    corrupt.unmount();

    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    const unavailable = renderHook(() => useLogicalMutation("test-unavailable"));
    expect(() => unavailable.result.current.keyFor("same action")).toThrow(MutationJournalAdmissionError);
    unavailable.unmount();
    getItem.mockRestore();
  });

  test("does not admit a mutation until its journal write is verified", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const denied = renderHook(() => useLogicalMutation("test-quota"));
    expect(() => denied.result.current.keyFor("same action")).toThrow(MutationJournalAdmissionError);
    denied.unmount();
    setItem.mockRestore();

    const getItem = vi.spyOn(Storage.prototype, "getItem")
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(JSON.stringify({
        signatureFingerprint: "0000000000000000",
        key: "different-key",
        phase: "pending",
        createdAt: new Date().toISOString(),
      }));
    const mismatched = renderHook(() => useLogicalMutation("test-readback"));
    expect(() => mismatched.result.current.keyFor("same action")).toThrow(MutationJournalAdmissionError);
    mismatched.unmount();
    getItem.mockRestore();
  });

  test("mounted callers reconcile through the same durable key", () => {
    const first = renderHook(() => useLogicalMutation("test-concurrent-hooks"));
    const second = renderHook(() => useLogicalMutation("test-concurrent-hooks"));
    const key = first.result.current.keyFor("same action");
    expect(second.result.current.keyFor("same action")).toBe(key);
    first.unmount();
    second.unmount();
  });

  test("persists completed step receipts across a renderer restart", () => {
    const first = renderHook(() => useLogicalMutation("test-checkpoint-restart"));
    const admission = first.result.current.acquire("same action");
    const checkpointed = first.result.current.checkpoint(admission.key, "task_created", "task-7");
    expect(checkpointed.completedSteps).toEqual({ task_created: "task-7" });
    first.unmount();

    const restarted = renderHook(() => useLogicalMutation("test-checkpoint-restart"));
    expect(restarted.result.current.acquire("same action")).toEqual({
      key: admission.key,
      completedSteps: { task_created: "task-7" },
    });
    expect(() => restarted.result.current.abandon(admission.key)).toThrow(PendingMutationConflictError);
    act(() => restarted.result.current.completePartial(admission.key));
    expect(() => restarted.result.current.acquire("corrected action")).not.toThrow();
    restarted.unmount();
  });

  test("does not admit a later effect until its checkpoint write is verified", () => {
    const mutation = renderHook(() => useLogicalMutation("test-checkpoint-write"));
    const admission = mutation.result.current.acquire("same action");
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    expect(() => mutation.result.current.checkpoint(admission.key, "task_created", "task-7"))
      .toThrow(MutationJournalAdmissionError);
    setItem.mockRestore();
    expect(mutation.result.current.acquire("same action").completedSteps).toEqual({});
    mutation.unmount();
  });

  test("rejects malformed and oversized checkpoint state", () => {
    window.localStorage.setItem("terminus.pending-mutation.v1.test-bad-checkpoint", JSON.stringify({
      version: 2,
      signatureFingerprint: "0000000000000000",
      key: "mutation-key",
      phase: "pending",
      createdAt: new Date().toISOString(),
      completedSteps: { "INVALID STEP": "task-7" },
    }));
    const malformed = renderHook(() => useLogicalMutation("test-bad-checkpoint"));
    expect(() => malformed.result.current.acquire("same action")).toThrow(MutationJournalAdmissionError);
    malformed.unmount();

    const oversized = renderHook(() => useLogicalMutation("test-large-checkpoint"));
    const admission = oversized.result.current.acquire("same action");
    expect(() => oversized.result.current.checkpoint(admission.key, "task_created", "x".repeat(4 * 1024 + 1)))
      .toThrow(MutationJournalAdmissionError);
    oversized.unmount();
  });

  test("keeps the prior key when durable cleanup fails", () => {
    const first = renderHook(() => useLogicalMutation("test-cleanup-failure"));
    const key = first.result.current.keyFor("same action");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    expect(() => first.result.current.settle(key)).toThrow(MutationJournalAdmissionError);
    first.unmount();

    const restarted = renderHook(() => useLogicalMutation("test-cleanup-failure"));
    expect(restarted.result.current.keyFor("same action")).toBe(key);
    expect(() => restarted.result.current.keyFor("changed action")).toThrow(PendingMutationConflictError);
    restarted.unmount();
  });

  test("rejects an oversized canonical signature before touching storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const mutation = renderHook(() => useLogicalMutation("test-large-signature"));
    expect(() => mutation.result.current.keyFor("x".repeat(64 * 1024 + 1))).toThrow(MutationJournalAdmissionError);
    expect(setItem).not.toHaveBeenCalled();
    mutation.unmount();
  });

  test("classifies only authoritative rejection responses as definitive", () => {
    expect(isDefinitiveMutationFailure(new TerminusApiError(0, "network error", null))).toBe(false);
    expect(
      isDefinitiveMutationFailure(
        new TerminusApiError(409, "approval already resolved", {
          code: "APPROVAL_ALREADY_RESOLVED",
          message: "approval already resolved",
          retryable: false,
          category: "conflict",
        }),
      ),
    ).toBe(true);
    expect(
      isDefinitiveMutationFailure(
        new TerminusApiError(503, "temporarily unavailable", {
          code: "UNAVAILABLE",
          message: "temporarily unavailable",
          retryable: true,
          category: "internal",
        }),
      ),
    ).toBe(false);
  });
});

describe("ApprovalCard mutation reconciliation", () => {
  test("does not dispatch when the mutation journal cannot be persisted", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const resolveApproval = vi.spyOn(api, "resolveApproval");

    render(
      <ApprovalCard
        id="approval-journal-blocked"
        operationHash="hash-approval-journal-blocked"
        action="Run migration"
        operation="npm run migrate"
        risk="normal"
        scope={["workspace://db"]}
        canPersist
        authorizationReady
        supportedDecisions={decisions}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Allow once/ }));
    expect(resolveApproval).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent("request was not sent");
  });

  test("releases an already-resolved approval and asks the parent to refresh", async () => {
    const user = userEvent.setup();
    const onResolved = vi.fn();
    vi.spyOn(api, "resolveApproval").mockRejectedValueOnce(
      new TerminusApiError(409, "approval already resolved", {
        code: "APPROVAL_ALREADY_RESOLVED",
        message: "approval already resolved",
        retryable: false,
        category: "conflict",
      }),
    );

    render(
      <ApprovalCard
        id="approval-logical-mutation"
        operationHash="hash-approval-logical-mutation"
        action="Run migration"
        operation="npm run migrate"
        risk="normal"
        scope={["workspace://db"]}
        canPersist
        authorizationReady
        supportedDecisions={decisions}
        onResolved={onResolved}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Allow once/ }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith("allow_once"));
  });
});

describe("Material question mutation reconciliation", () => {
  test("abandons a definitive success:false response so a changed choice can be submitted", async () => {
    const question: MaterialQuestionSnapshot = {
      id: "question-logical-mutation",
      taskId: "task-logical-mutation",
      trigger: "irreversible_effect",
      questionText: "Publish the artifact?",
      consequenceMatrix: { Publish: "Publishes it.", Hold: "Keeps it private." },
      options: ["Publish", "Hold"],
      status: "PENDING",
      suggestedOption: null,
      selectedOption: null,
      createdAt: "2026-08-23T12:00:00.000Z",
      resolvedAt: null,
    };
    vi.spyOn(arpV2, "listMaterialQuestions").mockResolvedValue([question]);
    vi.spyOn(arpV2, "resolveMaterialQuestion")
      .mockResolvedValueOnce({ success: false, question: null, error: "Publish is no longer available." })
      .mockResolvedValueOnce({
        success: true,
        question: { ...question, status: "ANSWERED", selectedOption: "Hold", resolvedAt: "2026-08-23T12:01:00.000Z" },
        error: null,
      });

    const user = userEvent.setup();
    render(<MaterialQuestionCard taskId="task-logical-mutation" />);
    await user.click(await screen.findByRole("button", { name: "Choose Publish for Publish the artifact?" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Publish is no longer available.");

    await user.click(screen.getByRole("button", { name: "Choose Hold for Publish the artifact?" }));
    await waitFor(() => expect(arpV2.resolveMaterialQuestion).toHaveBeenCalledTimes(2));
  });
});
