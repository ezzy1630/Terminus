import { describe, expect, it } from "bun:test";
import {
  compileSkill,
  compileWorkflowJson,
  compileWorkflowDraft,
  parseSkillMarkdown,
  createSourceSpan,
} from "../src/index.js";

describe("Workflow and Skill Compiler", () => {
  it("compiles Markdown skill into typed Workflow IR with exact source spans", () => {
    const skillMarkdown = `---
name: Code Review Skill
description: Conducts automated code review and quality checks
---

# Code Review Procedure

## Instructions
1. Inspect modified source files and git diffs
2. Synthesize code review feedback and suggestions
3. Run linters and verify typecheck passes
4. Verify tests pass on changed modules
5. Approve changes for merge
`;

    const { workflow, report } = compileSkill(skillMarkdown, {
      sourcePath: "skills/code-review/SKILL.md",
      taskId: "task-test-1",
    });

    expect(workflow.name).toBe("Code Review Skill");
    expect(workflow.nodes.length).toBe(5);
    expect(workflow.edges.length).toBe(4);
    expect(workflow.sourceProvenance?.sourceKind).toBe("skill_markdown");
    expect(workflow.sourceProvenance?.sourcePath).toBe("skills/code-review/SKILL.md");
    expect(workflow.sourceProvenance?.sourceHash).toStartWith("sha256:");

    // Verify source spans are populated on nodes
    for (const node of workflow.nodes) {
      expect(node.sourceSpan).toBeDefined();
      expect(node.sourceSpan?.sourcePath).toBe("skills/code-review/SKILL.md");
      expect(node.sourceSpan?.startLine).toBeGreaterThan(0);
      expect(node.sourceSpan?.text).toBeDefined();
    }

    expect(report.reachability.allReachable).toBe(true);
  });

  it("compiles structured workflow JSON IR", () => {
    const jsonStr = JSON.stringify({
      id: "wf-custom-1",
      name: "Custom Data Pipeline",
      nodes: [
        { id: "fetch_data", title: "Fetch Data", kind: "deterministic" },
        { id: "transform_data", title: "Transform Data", kind: "deterministic" },
        { id: "verify_output", title: "Verify Output", kind: "verifier" },
      ],
      edges: [
        { sourceNodeId: "fetch_data", targetNodeId: "transform_data" },
        { sourceNodeId: "transform_data", targetNodeId: "verify_output" },
      ],
    });

    const { workflow, report } = compileWorkflowJson(jsonStr, { sourcePath: "workflow.json" });

    expect(workflow.id).toBe("wf-custom-1");
    expect(workflow.nodes.length).toBe(3);
    expect(workflow.edges.length).toBe(2);
    expect(report.valid).toBe(true);
  });

  it("accurately computes line and column source spans", () => {
    const text = "First line\nSecond line with target word\nThird line";
    const target = "target word";
    const startIdx = text.indexOf(target);
    const endIdx = startIdx + target.length;

    const span = createSourceSpan("test.txt", text, startIdx, endIdx);

    expect(span.sourcePath).toBe("test.txt");
    expect(span.startLine).toBe(2);
    expect(span.startColumn).toBe(18);
    expect(span.endLine).toBe(2);
    expect(span.endColumn).toBe(29);
    expect(span.text).toBe("target word");
  });
});
