import { describe, expect, test } from "bun:test";
import type { Uuid7 } from "@terminus/domain";
import { parseNodeSpec } from "./node-spec.js";
import { deriveVerificationNodes } from "./plan-derivation.js";

function idSource(): () => Uuid7 {
  let counter = 1;
  return () => {
    const suffix = counter.toString(16).padStart(12, "0");
    counter += 1;
    return `01900000-0000-7000-8000-${suffix}` as Uuid7;
  };
}

function specs(nodes: readonly { readonly id: string; readonly specification: string }[]) {
  return new Map(nodes.map((node) => [node.id, parseNodeSpec(node.specification)]));
}

describe("verification plan derivation", () => {
  test("calibrates no-mutation, ordinary, and high-risk plans", () => {
    const derive = (riskClass: "low" | "normal" | "high", changedFiles: string[]) =>
      deriveVerificationNodes({
        criteria: [],
        objective: "calibrate",
        riskClass,
        mode: "admission",
        signals: { changedFiles },
        idSource: idSource(),
      });

    const noMutation = derive("normal", []);
    expect(noMutation.verificationTier).toBe(0);
    expect(noMutation.nodes.map((node) => parseNodeSpec(node.specification).predicateType)).toEqual([
      "acceptance_query",
    ]);

    const lowRiskDoc = derive("low", ["docs/guide.md"]);
    expect(lowRiskDoc.verificationTier).toBe(1);
    expect(lowRiskDoc.nodes.map((node) => parseNodeSpec(node.specification).predicateType)).toEqual([
      "diff_policy",
    ]);

    const ordinary = derive("normal", ["src/index.ts"]);
    expect(ordinary.verificationTier).toBe(2);
    expect(ordinary.nodes.some((node) => parseNodeSpec(node.specification).predicateType === "diff_policy")).toBe(true);

    const highRisk = derive("high", ["src/auth.ts"]);
    expect(highRisk.verificationTier).toBe(3);
    const highRiskPredicates = highRisk.nodes.map((node) => parseNodeSpec(node.specification).predicateType);
    expect(highRiskPredicates).toContain("security_scanner");
    expect(highRiskPredicates).toContain("detached_review");
  });

  test("selects checks from code, risk, scope, and criterion signals", () => {
    const derivation = deriveVerificationNodes({
      criteria: [
        {
          id: "api",
          statement: "The API integration works",
          verificationHint: "predicate: integration_test",
          required: true,
        },
        {
          id: "migration",
          statement: "The migration is reversible",
          verificationHint: "command: bun test tests/migration.test.ts",
          required: false,
        },
      ],
      objective: "Ship the provider-neutral control path",
      riskClass: "high",
      mode: "admission",
      signals: {
        changedFiles: [
          "src/app.ts",
          "src/app.test.ts",
          "prisma/migrations/001_init.sql",
          "proto/api.proto",
          "src/generated/client.ts",
          "src/auth/token.ts",
          "apps/web/App.tsx",
        ],
        projectFiles: ["package.json"],
        instructionHashes: ["sha256:instruction"],
        failingTests: ["tests/migration.test.ts"],
        diagnostics: ["TS2322"],
        nativeTestCommands: ["bun test src/app.test.ts"],
        nativeRecipeSources: ["package.json"],
        nativeRecipeSourceVersions: [`package.json=sha256:${"b".repeat(64)}`],
        repositoryMap: {
          sourceVersion: `sha256:${"a".repeat(64)}`,
          entryCount: 7,
          totalEntryCount: 9,
          omittedEntries: 2,
          continuationToken: "v1|sha256:revision|7",
          paths: ["src/app.ts"],
        },
        generatedPaths: ["src/generated/client.ts"],
        uiComputerUseAvailable: true,
      },
      idSource: idSource(),
    });

    const parsed = specs(derivation.nodes);
    const predicateTypes = new Set([...parsed.values()].map((spec) => spec.predicateType));
    expect(predicateTypes).toEqual(new Set([
      "file_parses",
      "formatter_check",
      "static_diagnostics",
      "unit_test",
      "integration_test",
      "ui_e2e",
      "security_scanner",
      "schema_compatibility",
      "migration_dry_run",
      "diff_policy",
      "detached_review",
    ]));

    const nativeTest = derivation.nodes.find((node) => parsed.get(node.id)?.command === "bun test src/app.test.ts");
    expect(nativeTest).toBeDefined();
    const criterionCommand = derivation.nodes.find((node) => parsed.get(node.id)?.command === "bun test tests/migration.test.ts");
    expect(criterionCommand?.acceptanceCriterionId).toBe("migration");
    expect(derivation.nodes.find((node) => node.acceptanceCriterionId === "api")).toBeDefined();
    expect(derivation.nodes.filter((node) => node.acceptanceCriterionId === null).every((node) => node.required)).toBe(true);
    expect(derivation.completionExpression).toContain(
      derivation.nodes.find((node) => node.acceptanceCriterionId === "api")?.id ?? "missing",
    );
    expect(derivation.completionExpression).not.toContain(
      derivation.nodes.find((node) => node.acceptanceCriterionId === "migration")?.id ?? "missing",
    );

    const apiNode = derivation.nodes.find((node) => node.acceptanceCriterionId === "api");
    const apiSpec = apiNode === undefined ? null : parsed.get(apiNode.id);
    expect(apiSpec?.observations).toMatchObject({
      derivationVersion: "terminus.verification.plan.v1",
      mode: "admission",
      objectivePresent: true,
      signalSummary: {
        instructionHashCount: 1,
        failingTestCount: 1,
        diagnosticCount: 1,
        nativeRecipeSourceCount: 1,
        nativeRecipeSourceVersionCount: 1,
        repositoryMapAvailable: true,
        repositoryMapEntryCount: 7,
        repositoryMapTotalEntryCount: 9,
        repositoryMapOmittedEntryCount: 2,
        repositoryMapContinuationAvailable: true,
        uiComputerUseAvailable: true,
      },
    });
    expect(derivation.rationale.get(apiNode?.id ?? "")).toContain("criterion selected an explicit predicate");
  });

  test("derives a required governed UI predicate when the UI backend is unavailable", () => {
    const derivation = deriveVerificationNodes({
      criteria: [{
        id: "ui",
        statement: "The settings screen shows the new provider state",
        verificationHint: null,
        required: true,
      }],
      objective: "Verify the rendered settings screen",
      riskClass: "normal",
      mode: "admission",
      signals: {
        changedFiles: ["apps/web/Settings.tsx"],
        uiComputerUseAvailable: false,
      },
      idSource: idSource(),
    });

    const uiNode = derivation.nodes.find((node) => node.acceptanceCriterionId === "ui");
    expect(uiNode).toBeDefined();
    if (uiNode === undefined) throw new Error("expected a UI criterion node");
    const uiSpec = parseNodeSpec(uiNode.specification);
    expect(uiSpec.predicateType).toBe("ui_e2e");
    expect(uiSpec.observations).toMatchObject({
      uiComputerUseAvailable: false,
      uiComputerUseRequired: true,
    });
    expect(derivation.rationale.get(uiNode.id)).toContain("UI paths and rendered behavior require governed computer use");
  });

  test("keeps incremental auxiliary checks optional and out of the required criterion path", () => {
    const derivation = deriveVerificationNodes({
      criteria: [{
        id: "api",
        statement: "The API schema remains compatible",
        verificationHint: null,
        required: true,
      }],
      objective: "Make a small API change",
      riskClass: "normal",
      mode: "incremental",
      signals: {
        changedFiles: ["src/api.ts", "prisma/migrations/001.sql"],
        uiComputerUseAvailable: false,
      },
      idSource: idSource(),
    });

    const criterion = derivation.nodes.find((node) => node.acceptanceCriterionId === "api");
    expect(criterion).toBeDefined();
    expect(criterion?.required).toBe(true);
    expect(criterion?.dependsOn).toEqual([]);
    expect(derivation.nodes.filter((node) => node.acceptanceCriterionId === null).every((node) => !node.required)).toBe(true);
    if (criterion === undefined) throw new Error("expected an API criterion node");
    expect(derivation.completionExpression).toBe(criterion.id);
    expect(parseNodeSpec(criterion?.specification ?? "").predicateType).toBe("schema_compatibility");
  });
});

describe("node timeout budgets", () => {
  const criteria = [
    { id: "tests", statement: "The suite passes", verificationHint: "predicate: unit_test", required: true },
    { id: "types", statement: "It typechecks", verificationHint: "predicate: static_diagnostics", required: true },
  ];

  test("test nodes get 600 s and parse/lint nodes 120 s by default", () => {
    // 30 s made every repository-native recipe (`cargo test`, `bun run test`,
    // `pytest`) a guaranteed timeout, and those recipes are *required* nodes:
    // admission was arithmetically impossible.
    const derivation = deriveVerificationNodes({
      criteria,
      objective: "fix the bug",
      riskClass: "normal",
      mode: "admission",
      signals: { changedFiles: ["src/a.ts"] },
      idSource: idSource(),
    });
    const byPredicate = new Map(
      derivation.nodes.map((node) => [parseNodeSpec(node.specification).predicateType, node.timeout]),
    );
    expect(byPredicate.get("unit_test")).toBe(600_000);
    expect(byPredicate.get("static_diagnostics")).toBe(120_000);
    expect(byPredicate.get("file_parses") ?? 120_000).toBe(120_000);
    for (const node of derivation.nodes) expect(node.timeout).toBeGreaterThanOrEqual(120_000);
  });

  test("the contract budget raises a node above its floor but never below it", () => {
    const withBudget = (timeoutSeconds: number) => new Map(
      deriveVerificationNodes({
        criteria,
        objective: "fix the bug",
        riskClass: "normal",
        mode: "admission",
        signals: { changedFiles: ["src/a.ts"] },
        timeoutSeconds,
        idSource: idSource(),
      }).nodes.map((node) => [parseNodeSpec(node.specification).predicateType, node.timeout]),
    );
    // A generous contract budget raises both classes, each capped by its own
    // ceiling (30 min tests / 10 min static).
    const generous = withBudget(3_600);
    expect(generous.get("unit_test")).toBe(1_800_000);
    expect(generous.get("static_diagnostics")).toBe(600_000);
    // A stingy one cannot reintroduce a guaranteed timeout.
    const stingy = withBudget(30);
    expect(stingy.get("unit_test")).toBe(600_000);
    expect(stingy.get("static_diagnostics")).toBe(120_000);
    // An in-range budget is honoured exactly.
    expect(withBudget(900).get("unit_test")).toBe(900_000);
  });
});
