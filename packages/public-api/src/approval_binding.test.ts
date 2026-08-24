import { describe, expect, test } from "bun:test";
import {
  ApprovalBindingV1,
  ApprovalOperationV1,
  canonicalApprovalBinding,
  type ApprovalBindingV1 as ApprovalBinding,
} from "./index.js";

const binding: ApprovalBinding = {
  version: 1,
  task_id: "task-1",
  task_contract_version: 3,
  user_intent_ref: "turn://turn-1",
  policy_version: "secure-local-default@4",
  effect_kind: "EXECUTE_LOCAL",
  exact_action: "exec argv=[\"bun\",\"run\",\"check\"] cwd=workspace://active",
  resources: ["workspace://active/package.json", "workspace://active/src"],
  destinations: [],
  source_versions: {
    "workspace://active/package.json": "sha256:abc",
    "policy://secure-local-default": "v4",
  },
  secret_scope: [],
  risk: { class: "normal", effects: ["process", "read"] },
  taint: { influenced_by_untrusted_content: false, warning: null },
  expires_at: "2026-08-24T00:00:00Z",
  use_limit: 1,
};

describe("approval operation binding", () => {
  test("strictly validates the complete versioned envelope", () => {
    expect(ApprovalOperationV1.parse({
      binding,
      display: {
        summary: "Run project checks",
        exact_action: binding.exact_action,
        reason: "The command starts a local process.",
        reversibility: "reversible",
        environment: "local workspace",
      },
    }).binding).toEqual(binding);
    expect(ApprovalBindingV1.safeParse({ ...binding, extra: true }).success).toBe(false);
    expect(ApprovalBindingV1.safeParse({ ...binding, expires_at: "tomorrow" }).success).toBe(false);
    expect(ApprovalBindingV1.safeParse({ ...binding, destinations: [""] }).success).toBe(false);
  });

  test("normalizes unordered sets and object keys", () => {
    const reordered: ApprovalBinding = {
      ...binding,
      resources: [...binding.resources].reverse(),
      risk: { ...binding.risk, effects: [...binding.risk.effects].reverse() },
      source_versions: Object.fromEntries(Object.entries(binding.source_versions).reverse()),
    };
    expect(canonicalApprovalBinding(reordered)).toBe(canonicalApprovalBinding(binding));
  });

  test("changes the hash for every material authorization field", () => {
    const variants: ApprovalBinding[] = [
      { ...binding, exact_action: `${binding.exact_action} --watch` },
      { ...binding, destinations: ["https://example.com"] },
      { ...binding, source_versions: { ...binding.source_versions, "workspace://active/package.json": "sha256:def" } },
      { ...binding, secret_scope: ["capability://github/token"] },
      { ...binding, task_contract_version: binding.task_contract_version + 1 },
      { ...binding, policy_version: "secure-local-default@5" },
      { ...binding, taint: { influenced_by_untrusted_content: true, warning: "Untrusted tool output influenced this action." } },
      { ...binding, expires_at: "2026-08-24T00:01:00Z" },
      { ...binding, use_limit: 2 },
    ];
    for (const variant of variants) {
      expect(canonicalApprovalBinding(variant)).not.toBe(canonicalApprovalBinding(binding));
    }
  });
});
