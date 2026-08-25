import { describe, expect, test } from "bun:test";
import type { UiObservation, UiElementTarget, ComputerUseAction } from "@terminus/domain";
import {
  BrowserControlCoordinator,
  browserEffectBindingHash,
  selectBrowserControlPath,
  type BrowserControlCapabilities,
  type TypedBrowserAction,
} from "./browser-control.js";

const capabilities: BrowserControlCapabilities = {
  apiActions: [],
  mcpActions: [],
  dom: true,
  accessibility: true,
  cdp: true,
  vision: true,
};

const target: UiElementTarget = {
  elementId: "submit",
  role: "button",
  name: "Submit",
  selector: "#submit",
  boundingBox: { x: 10, y: 10, width: 100, height: 30 },
  textSnippet: "Submit",
  confidence: 0.99,
  semanticHash: "target-hash",
  evidenceSources: ["dom", "accessibility"],
};

const observation: UiObservation = {
  id: "obs-1",
  sessionId: "session-1",
  taskId: "task-1",
  timestamp: "2026-08-24T00:00:00.000Z" as UiObservation["timestamp"],
  viewport: { width: 800, height: 600, devicePixelRatio: 1, scaleFactor: 1 },
  screenshotArtifactId: null,
  domTreeArtifactId: "artifact://sha256/dom",
  documentUri: "https://example.test/checkout",
  accessibilityTree: [{
    nodeId: "submit",
    role: "button",
    name: "Submit",
    description: null,
    value: null,
    disabled: false,
    focused: true,
    boundingBox: target.boundingBox,
    childrenNodeIds: [],
  }],
  focusedElementId: "submit",
  targetElements: [target],
  taintLabel: "UNTRUSTED_WEB",
  version: 1,
};

function action(overrides: Partial<ComputerUseAction> = {}): TypedBrowserAction {
  return {
    actionId: "action-1",
    taskId: "task-1",
    observationId: observation.id,
    observationVersion: observation.version,
    kind: "click",
    target,
    coordinate: null,
    text: null,
    keys: null,
    scrollDelta: null,
    intent: "submit the form",
    requiresSemanticVerification: true,
    effectClass: "read_only",
    ...overrides,
  } as TypedBrowserAction;
}

describe("typed browser control", () => {
  test("selects the required control hierarchy", () => {
    expect(selectBrowserControlPath("click", {
      ...capabilities,
      apiActions: ["click"],
      mcpActions: ["click"],
    })).toBe("api");
    expect(selectBrowserControlPath("click", {
      ...capabilities,
      apiActions: [],
      mcpActions: ["click"],
    })).toBe("mcp");
    expect(selectBrowserControlPath("click", {
      ...capabilities,
      apiActions: [],
      mcpActions: [],
      dom: false,
      accessibility: true,
    })).toBe("accessibility");
  });

  test("admits a structural target only against the current observation", () => {
    const plan = new BrowserControlCoordinator().plan(action(), observation, capabilities, null);
    expect(plan.admitted).toBe(true);
    if (plan.admitted) {
      expect(plan.controlPath).toBe("dom");
      expect(plan.semanticVerification?.verdict).toBe("verified");
      expect(plan.settlementRequired).toBe(false);
    }

    const stale = new BrowserControlCoordinator().plan(
      action({ observationVersion: 2 }),
      observation,
      capabilities,
      null,
    );
    expect(stale).toMatchObject({ admitted: false, reason: "stale_observation" });
  });

  test("requires an exact approval binding for irreversible submit", () => {
    const submit = action({ kind: "submit", effectClass: "irreversible" });
    const coordinator = new BrowserControlCoordinator();
    expect(coordinator.plan(submit, observation, capabilities, null)).toMatchObject({
      admitted: false,
      reason: "approval_required",
    });
    const bindingHash = browserEffectBindingHash(submit, observation);
    const plan = coordinator.plan(submit, observation, capabilities, {
      approvalId: "approval-1",
      taskId: submit.taskId,
      actionId: submit.actionId,
      bindingHash,
      status: "approved",
    });
    expect(plan.admitted).toBe(true);
    if (plan.admitted) expect(plan.settlementRequired).toBe(true);
  });

  test("allows a typed navigate through an API without a DOM target", () => {
    const navigate = action({
      kind: "navigate",
      target: null,
      text: "https://example.test/account",
      intent: "open the account page",
      requiresSemanticVerification: false,
    });
    const plan = new BrowserControlCoordinator().plan(navigate, observation, {
      ...capabilities,
      apiActions: ["navigate"],
    }, null);
    expect(plan).toMatchObject({ admitted: true, controlPath: "api" });
  });
});
