import { describe, expect, it } from "bun:test";
import {
  createSoftwarePatchWorkflow,
  createDatabaseMigrationWorkflow,
  createSecurityReviewWorkflow,
} from "../src/standard_workflows.js";

describe("Standard Organizational Workflows", () => {
  it("compiles valid standard software patch workflow", () => {
    const wf = createSoftwarePatchWorkflow("task-patch-123");

    expect(wf.id).toBe("wf-software-patch-v1");
    expect(wf.nodes.length).toBe(7);
    expect(wf.edges.length).toBe(5);

    const commitNode = wf.nodes.find((n) => n.id === "commit_patch");
    expect(commitNode).toBeDefined();
    expect(commitNode?.kind).toBe("effect");
    expect(commitNode?.compensationNodeId).toBe("rollback_patch");
  });

  it("compiles valid database migration workflow with human signoff", () => {
    const wf = createDatabaseMigrationWorkflow("task-db-456");

    expect(wf.id).toBe("wf-database-migration-v1");
    expect(wf.nodes.length).toBe(7);

    const humanNode = wf.nodes.find((n) => n.id === "human_signoff");
    expect(humanNode).toBeDefined();
    expect(humanNode?.kind).toBe("human");
  });

  it("compiles valid security review workflow", () => {
    const wf = createSecurityReviewWorkflow("task-sec-789");

    expect(wf.id).toBe("wf-security-review-v1");
    expect(wf.nodes.length).toBe(4);
  });
});
