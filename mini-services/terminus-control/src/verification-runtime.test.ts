import { describe, expect, test } from "bun:test";
import { defaultCriteriaNodes } from "./verification-runtime.js";

describe("verification runtime plan nodes", () => {
  test("namespaces criterion nodes across repair plans", () => {
    const criteria = [
      { id: "first", statement: "first", verificationHint: null, required: true },
      { id: "second", statement: "second", verificationHint: null, required: true },
    ];
    const firstPlan = defaultCriteriaNodes(criteria);
    const secondPlan = defaultCriteriaNodes(criteria);

    expect(firstPlan.map((node) => node.id)).not.toEqual(secondPlan.map((node) => node.id));
    expect(firstPlan[1]?.dependsOn).toEqual([firstPlan[0]?.id]);
    expect(secondPlan[1]?.dependsOn).toEqual([secondPlan[0]?.id]);
  });

  test("namespaces the default parse, diagnostics, and test chain", () => {
    const firstPlan = defaultCriteriaNodes([]);
    const secondPlan = defaultCriteriaNodes([]);

    expect(firstPlan.map((node) => node.id)).not.toEqual(secondPlan.map((node) => node.id));
    expect(firstPlan[1]?.dependsOn).toEqual([firstPlan[0]?.id]);
    expect(firstPlan[2]?.dependsOn).toEqual([firstPlan[1]?.id]);
  });
});
