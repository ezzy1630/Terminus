/**
 * The one status vocabulary (lib/task-lifecycle.ts).
 *
 * The regression these tests exist to prevent: a task showed "Queued" in the
 * sidebar and "Running" on the board at the same moment, because each surface
 * interpreted a different projection of the same stored status. Every
 * assertion below pins the property that both inputs land on one lifecycle.
 */
import { describe, expect, it } from "vitest";
import {
  BOARD_COLUMNS,
  TASK_LIFECYCLE,
  boardColumnForLifecycle,
  lifecycleFromDomainStatus,
  lifecycleFromTask,
  lifecycleFromV2Status,
  lifecycleIsActive,
  lifecycleIsTerminal,
  lifecycleLabel,
  lifecycleNeedsAttention,
  lifecycleTone,
  type TaskLifecycle,
} from "../src/lib/task-lifecycle";

/** SPEC §28.3, mirrored by prisma `Task.status`. */
const DOMAIN_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "NEEDS_USER_DECISION",
  "BLOCKED",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "FAILED_VERIFICATION",
  "BUDGET_EXHAUSTED",
  "POLICY_DENIED",
  "ABORTED",
] as const;

/** The control plane's ARP v2 projection of the above. */
const V2_STATUSES = [
  "DRAFT",
  "READY",
  "RUNNING",
  "WAITING_USER",
  "WAITING_AUTH",
  "WAITING_RESOURCE",
  "PAUSED",
  "VERIFYING",
  "COMPLETED",
  "PARTIAL",
  "BLOCKED",
  "CANCELLED",
  "FAILED",
] as const;

/**
 * The control plane's own v1→v2 mapping, copied here so the test fails if the
 * client's two entry points ever drift apart from the server's projection.
 */
const V1_TO_V2: Record<(typeof DOMAIN_STATUSES)[number], (typeof V2_STATUSES)[number]> = {
  DRAFT: "DRAFT",
  ACTIVE: "RUNNING",
  NEEDS_USER_DECISION: "WAITING_USER",
  BLOCKED: "BLOCKED",
  VERIFYING: "VERIFYING",
  COMPLETED: "COMPLETED",
  ABORTED: "CANCELLED",
  FAILED: "FAILED",
  FAILED_VERIFICATION: "FAILED",
  BUDGET_EXHAUSTED: "FAILED",
  POLICY_DENIED: "FAILED",
};

describe("lifecycleFromDomainStatus", () => {
  it("maps every SPEC §28.3 status to a known lifecycle", () => {
    for (const status of DOMAIN_STATUSES) {
      const lifecycle = lifecycleFromDomainStatus(status);
      expect(TASK_LIFECYCLE).toContain(lifecycle);
      expect(lifecycle).not.toBe("unknown");
    }
  });

  it("reports queued for a task that has not started", () => {
    expect(lifecycleFromDomainStatus("DRAFT")).toBe("queued");
  });

  it("refines ACTIVE by phase", () => {
    expect(lifecycleFromDomainStatus("ACTIVE", "INTAKE")).toBe("planning");
    expect(lifecycleFromDomainStatus("ACTIVE", "CONTRACT")).toBe("planning");
    expect(lifecycleFromDomainStatus("ACTIVE", "DISCOVER")).toBe("planning");
    expect(lifecycleFromDomainStatus("ACTIVE", "PLAN")).toBe("planning");
    expect(lifecycleFromDomainStatus("ACTIVE", "IMPLEMENT")).toBe("working");
    expect(lifecycleFromDomainStatus("ACTIVE", "VERIFY")).toBe("verifying");
    expect(lifecycleFromDomainStatus("ACTIVE", "REVIEW")).toBe("review");
  });

  it("reports working for an ACTIVE task with an absent or unrecognised phase", () => {
    expect(lifecycleFromDomainStatus("ACTIVE")).toBe("working");
    expect(lifecycleFromDomainStatus("ACTIVE", null)).toBe("working");
    expect(lifecycleFromDomainStatus("ACTIVE", "")).toBe("working");
    expect(lifecycleFromDomainStatus("ACTIVE", "SOMETHING_NEW")).toBe("working");
  });

  it("routes both human-blocking statuses to needs_you", () => {
    expect(lifecycleFromDomainStatus("NEEDS_USER_DECISION")).toBe("needs_you");
    expect(lifecycleFromDomainStatus("BLOCKED")).toBe("needs_you");
  });

  it("keeps every terminal failure distinguishable from cancellation", () => {
    expect(lifecycleFromDomainStatus("FAILED")).toBe("failed");
    expect(lifecycleFromDomainStatus("FAILED_VERIFICATION")).toBe("failed");
    expect(lifecycleFromDomainStatus("BUDGET_EXHAUSTED")).toBe("failed");
    expect(lifecycleFromDomainStatus("POLICY_DENIED")).toBe("failed");
    expect(lifecycleFromDomainStatus("ABORTED")).toBe("cancelled");
  });

  it("is case insensitive and defensive about unknown statuses", () => {
    expect(lifecycleFromDomainStatus("completed")).toBe("done");
    expect(lifecycleFromDomainStatus("NOT_A_STATUS")).toBe("unknown");
  });
});

describe("lifecycleFromV2Status", () => {
  it("maps every ARP v2 status to a known lifecycle", () => {
    for (const status of V2_STATUSES) {
      const lifecycle = lifecycleFromV2Status(status);
      expect(TASK_LIFECYCLE).toContain(lifecycle);
      expect(lifecycle).not.toBe("unknown");
    }
  });

  it("reports queued for a task that has not started", () => {
    // The original defect: DRAFT and READY were placed in the Running column.
    expect(lifecycleFromV2Status("DRAFT")).toBe("queued");
    expect(lifecycleFromV2Status("READY")).toBe("queued");
    expect(boardColumnForLifecycle(lifecycleFromV2Status("DRAFT"))).toBe("queued");
  });

  it("routes every waiting variant to needs_you", () => {
    for (const status of ["WAITING_USER", "WAITING_AUTH", "WAITING_RESOURCE", "PAUSED", "BLOCKED"]) {
      expect(lifecycleFromV2Status(status)).toBe("needs_you");
    }
  });

  it("treats PARTIAL as a review decision rather than a failure", () => {
    expect(lifecycleFromV2Status("PARTIAL")).toBe("review");
  });
});

describe("the two entry points agree", () => {
  it("lands the same task on the same lifecycle through either projection", () => {
    for (const domain of DOMAIN_STATUSES) {
      const viaDomain = lifecycleFromDomainStatus(domain);
      const viaV2 = lifecycleFromV2Status(V1_TO_V2[domain]);
      expect(
        viaV2,
        `${domain} → ${viaDomain} via domain but → ${viaV2} via v2 (${V1_TO_V2[domain]})`,
      ).toBe(viaDomain);
    }
  });

  it("agrees on the board column, which is where the disagreement was visible", () => {
    for (const domain of DOMAIN_STATUSES) {
      expect(boardColumnForLifecycle(lifecycleFromDomainStatus(domain)))
        .toBe(boardColumnForLifecycle(lifecycleFromV2Status(V1_TO_V2[domain])));
    }
  });

  it("only disagrees where v2 is knowably coarser, and never within one status", () => {
    // ACTIVE+PLAN is "planning" via the domain path but v2 has no phase, so it
    // can only say "working". Both must still land in the same board column.
    expect(lifecycleFromDomainStatus("ACTIVE", "PLAN")).toBe("planning");
    expect(lifecycleFromV2Status("RUNNING")).toBe("working");
    expect(boardColumnForLifecycle("planning")).toBe(boardColumnForLifecycle("working"));
  });
});

describe("lifecycleFromTask", () => {
  it("reads status and phase off a domain task", () => {
    expect(lifecycleFromTask({ status: "ACTIVE", phase: "VERIFY" })).toBe("verifying");
    expect(lifecycleFromTask({ status: "DRAFT", phase: "INTAKE" })).toBe("queued");
  });

  it("does not throw on a missing task", () => {
    expect(lifecycleFromTask(null)).toBe("unknown");
    expect(lifecycleFromTask(undefined)).toBe("unknown");
  });
});

describe("presentation helpers are total", () => {
  it("labels and tones every lifecycle", () => {
    for (const lifecycle of TASK_LIFECYCLE) {
      expect(lifecycleLabel(lifecycle).length).toBeGreaterThan(0);
      expect(["neutral", "info", "warning", "error", "success"]).toContain(lifecycleTone(lifecycle));
    }
  });

  it("assigns every lifecycle to exactly one board column", () => {
    const ids = new Set(BOARD_COLUMNS.map((column) => column.id));
    for (const lifecycle of TASK_LIFECYCLE) {
      expect(ids).toContain(boardColumnForLifecycle(lifecycle));
    }
  });
});

describe("attention is separate from lifecycle", () => {
  it("does not treat a healthy running agent as something to act on", () => {
    expect(lifecycleNeedsAttention("working")).toBe(false);
    expect(lifecycleNeedsAttention("planning")).toBe(false);
    expect(lifecycleNeedsAttention("verifying")).toBe(false);
    expect(lifecycleNeedsAttention("queued")).toBe(false);
  });

  it("claims attention for blocked, failed, and reviewable work", () => {
    expect(lifecycleNeedsAttention("needs_you")).toBe(true);
    expect(lifecycleNeedsAttention("failed")).toBe(true);
    expect(lifecycleNeedsAttention("review")).toBe(true);
  });

  it("never claims attention for finished work", () => {
    expect(lifecycleNeedsAttention("done")).toBe(false);
    expect(lifecycleNeedsAttention("cancelled")).toBe(false);
  });

  it("keeps active and terminal disjoint", () => {
    for (const lifecycle of TASK_LIFECYCLE) {
      expect(lifecycleIsActive(lifecycle) && lifecycleIsTerminal(lifecycle)).toBe(false);
    }
  });
});

describe("board columns", () => {
  it("exposes the five agreed columns in flow order", () => {
    expect(BOARD_COLUMNS.map((column) => column.id)).toEqual([
      "queued",
      "working",
      "needs_you",
      "review",
      "done",
    ]);
  });

  it("puts failures in front of the human rather than hiding them in Done", () => {
    expect(boardColumnForLifecycle("failed")).toBe("needs_you");
  });

  it("does not strand unknown work outside the board", () => {
    const lifecycle: TaskLifecycle = "unknown";
    expect(boardColumnForLifecycle(lifecycle)).toBe("queued");
  });
});
