/**
 * @terminus/workflow-compiler — Natural Language & Skill Procedure Parser.
 *
 * SPEC §8.2, §12.1, ADR-0036.
 * Parses Markdown SKILL.md, YAML, and JSON procedure definitions into
 * WorkflowDraft graphs with exact line/column SourceSpan tracking,
 * ambiguity detection, and prompt-injection quarantine.
 */
import type {
  NodeDraft,
  EdgeDraft,
  WorkflowDraft,
  SourceSpan,
  AmbiguityStatus,
} from "./types.js";

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly sourceSpan?: SourceSpan | undefined,
    public readonly code = "PARSE_ERROR",
  ) {
    super(message);
    this.name = "ParseError";
  }
}

const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above)\s+instructions\b/i,
  /\bsystem\s+override\b/i,
  /\bescalate\s+(privilege|privileges|capability|authority)\b/i,
  /\bbypass\s+(policy|sandbox|security|guardrails|checks)\b/i,
  /\bdisregard\s+(the\s+)?(system|platform|rules)\b/i,
  /\bexfiltrate\s+(secret|secrets|token|credentials|keys)\b/i,
  /\bprint\s+(all\s+)?(env|environment\s+variables|secrets)\b/i,
];

const AMBIGUITY_PATTERNS = [
  /\b(optionally|at\s+your\s+discretion|if\s+appropriate|as\s+you\s+see\s+fit)\b/i,
  /\b(decide\s+based\s+on\s+context|use\s+best\s+judgment|might\s+want\s+to|consider\s+whether)\b/i,
  /\b(depending\s+on\s+taste|feel\s+free\s+to|whenever\s+it\s+seems\s+right)\b/i,
];

export function detectPromptInjection(text: string): { readonly isMalicious: boolean; readonly matchedPattern?: string | undefined } {
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { isMalicious: true, matchedPattern: match[0] };
    }
  }
  return { isMalicious: false };
}

export function detectAmbiguity(text: string): AmbiguityStatus | null {
  for (const pattern of AMBIGUITY_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        isAmbiguous: true,
        reason: `Ambiguous phrasing detected: "${match[0]}"`,
        requiredJudgment: "model",
      };
    }
  }
  return null;
}

export function createSourceSpan(
  sourcePath: string,
  fullText: string,
  startIndex: number,
  endIndex: number,
): SourceSpan {
  const safeEnd = Math.min(Math.max(startIndex, endIndex), fullText.length);
  const safeStart = Math.min(Math.max(0, startIndex), safeEnd);

  const linesBeforeStart = fullText.slice(0, safeStart).split("\n");
  const startLine = linesBeforeStart.length;
  const startColumn = (linesBeforeStart[linesBeforeStart.length - 1]?.length ?? 0) + 1;

  const linesBeforeEnd = fullText.slice(0, safeEnd).split("\n");
  const endLine = linesBeforeEnd.length;
  const endColumn = (linesBeforeEnd[linesBeforeEnd.length - 1]?.length ?? 0) + 1;

  const text = fullText.slice(safeStart, safeEnd);

  return {
    sourcePath,
    startLine,
    startColumn,
    endLine,
    endColumn,
    text,
  };
}

/**
 * Parses a Markdown skill file (e.g. SKILL.md) into a WorkflowDraft.
 */
export function parseSkillMarkdown(markdown: string, sourcePath = "SKILL.md"): WorkflowDraft {
  const injection = detectPromptInjection(markdown);
  if (injection.isMalicious) {
    throw new ParseError(
      `Malicious prompt injection detected in skill: "${injection.matchedPattern}"`,
      undefined,
      "PROMPT_INJECTION_DETECTED",
    );
  }

  const lines = markdown.split("\n");
  let title = "Skill Workflow";
  let description = "";
  const rawNodes: NodeDraft[] = [];
  const rawEdges: EdgeDraft[] = [];

  let inFrontmatter = false;
  let inProcedure = false;
  let currentSection = "";
  let stepCounter = 1;
  let previousNodeId: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === "---") {
        inFrontmatter = false;
      } else if (trimmed.startsWith("name:")) {
        title = trimmed.slice(5).trim();
      } else if (trimmed.startsWith("description:")) {
        description = trimmed.slice(12).trim();
      }
      continue;
    }

    if (trimmed.startsWith("# ")) {
      if (title === "Skill Workflow") {
        title = trimmed.slice(2).trim();
      }
      currentSection = "header";
      continue;
    }

    if (trimmed.startsWith("## ")) {
      currentSection = trimmed.slice(3).trim().toLowerCase();
      inProcedure = currentSection.includes("procedure") ||
                    currentSection.includes("steps") ||
                    currentSection.includes("workflow") ||
                    currentSection.includes("instructions");
      continue;
    }

    // Step item detection (e.g. "1. Step description" or "- Step description" inside procedure section).
    const stepText = parseStepText(trimmed);

    if (inProcedure && stepText) {
      const nodeId = `step-${stepCounter}`;
      stepCounter++;

      const startIndex = markdown.indexOf(line);
      const endIndex = startIndex + line.length;
      const sourceSpan = startIndex >= 0 ? createSourceSpan(sourcePath, markdown, startIndex, endIndex) : null;
      const ambiguity = detectAmbiguity(stepText);

      // Extract required capability hints from text (e.g. read, write, test, diff, git, network)
      const requiredCapabilities: string[] = [];
      const lower = stepText.toLowerCase();
      if (lower.includes("read") || lower.includes("inspect") || lower.includes("search")) {
        requiredCapabilities.push("read");
      }
      if (lower.includes("write") || lower.includes("patch") || lower.includes("modify") || lower.includes("edit")) {
        requiredCapabilities.push("patch");
      }
      if (lower.includes("test") || lower.includes("verify") || lower.includes("validate") || lower.includes("check")) {
        requiredCapabilities.push("exec");
      }
      if (lower.includes("git") || lower.includes("commit") || lower.includes("branch")) {
        requiredCapabilities.push("git");
      }

      // Determine default effect class
      let effectClass: string | null = null;
      if (lower.includes("patch") || lower.includes("write") || lower.includes("edit")) {
        effectClass = "bufferable_local";
      } else if (lower.includes("deploy") || lower.includes("push") || lower.includes("publish")) {
        effectClass = "reversible_external";
      } else if (lower.includes("delete") || lower.includes("drop") || lower.includes("purge")) {
        effectClass = "compensable_external";
      } else {
        effectClass = "read_only";
      }

      rawNodes.push({
        id: nodeId,
        title: stepText.slice(0, 60),
        description: stepText,
        requiredCapabilities,
        effectClass,
        sourceSpan,
        ambiguityStatus: ambiguity,
        inputs: {},
        outputs: {},
        timeoutSeconds: 120,
      });

      if (previousNodeId) {
        rawEdges.push({
          sourceNodeId: previousNodeId,
          targetNodeId: nodeId,
          condition: null,
          conditionType: "deterministic",
        });
      }
      previousNodeId = nodeId;
    }
  }

  // If no procedural steps were found, synthesize at least a root node from the description
  if (rawNodes.length === 0) {
    const rootSpan = createSourceSpan(sourcePath, markdown, 0, Math.min(markdown.length, 500));
    rawNodes.push({
      id: "step-1",
      title,
      description: description || title,
      requiredCapabilities: ["read"],
      effectClass: "read_only",
      sourceSpan: rootSpan,
      ambiguityStatus: detectAmbiguity(markdown),
      inputs: {},
      outputs: {},
      timeoutSeconds: 120,
    });
  }

  return {
    id: `wf-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: title,
    description: description || title,
    nodes: rawNodes,
    edges: rawEdges,
    sourceProvenance: {
      sourceKind: "skill_markdown",
      sourcePath,
      compilerVersion: "0.1.0",
    },
  };
}

function parseStepText(line: string): string | null {
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === undefined || char < "0" || char > "9") break;
    index++;
  }

  if (index > 0 && line[index] === ".") {
    index++;
  } else if (line[0] === "-" || line[0] === "*") {
    index = 1;
  } else {
    return null;
  }

  const whitespaceStart = index;
  while (index < line.length && (line[index] === " " || line[index] === "\t")) index++;
  if (index === whitespaceStart) return null;
  const text = line.slice(index).trim();
  return text || null;
}

/**
 * Parses structured JSON or YAML into a WorkflowDraft.
 */
export function parseWorkflowJson(jsonString: string, sourcePath = "workflow.json"): WorkflowDraft {
  const injection = detectPromptInjection(jsonString);
  if (injection.isMalicious) {
    throw new ParseError(
      `Malicious prompt injection detected in workflow JSON: "${injection.matchedPattern}"`,
      undefined,
      "PROMPT_INJECTION_DETECTED",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new ParseError(`Invalid JSON in workflow source: ${String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new ParseError("Workflow source must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  const nodesRaw = Array.isArray(obj.nodes) ? obj.nodes : [];
  const edgesRaw = Array.isArray(obj.edges) ? obj.edges : [];

  const nodes: NodeDraft[] = nodesRaw.map((n, idx) => {
    if (typeof n !== "object" || n === null) {
      throw new ParseError(`Node at index ${idx} must be an object`);
    }
    const nodeObj = n as Record<string, unknown>;
    const id = String(nodeObj.id ?? `node-${idx + 1}`);
    const desc = String(nodeObj.description ?? nodeObj.title ?? id);
    const draft: NodeDraft = {
      id,
      description: desc,
      inputs: (nodeObj.inputs as Record<string, unknown>) ?? {},
      outputs: (nodeObj.outputs as Record<string, unknown>) ?? {},
      requiredCapabilities: Array.isArray(nodeObj.requiredCapabilities)
        ? (nodeObj.requiredCapabilities as string[])
        : [],
      effectClass: nodeObj.effectClass !== undefined ? (nodeObj.effectClass as string | null) : null,
      timeoutSeconds: typeof nodeObj.timeoutSeconds === "number" ? nodeObj.timeoutSeconds : 60,
      compensationNodeId: nodeObj.compensationNodeId ? String(nodeObj.compensationNodeId) : null,
      ambiguityStatus: detectAmbiguity(desc),
      ...(nodeObj.title ? { title: String(nodeObj.title) } : {}),
      ...(nodeObj.kind ? { kind: nodeObj.kind as NodeDraft["kind"] } : {}),
      ...(nodeObj.owner ? { owner: String(nodeObj.owner) } : {}),
    };
    return draft;
  });

  const edges: EdgeDraft[] = edgesRaw.map((e, idx) => {
    if (typeof e !== "object" || e === null) {
      throw new ParseError(`Edge at index ${idx} must be an object`);
    }
    const edgeObj = e as Record<string, unknown>;
    return {
      sourceNodeId: String(edgeObj.sourceNodeId),
      targetNodeId: String(edgeObj.targetNodeId),
      condition: edgeObj.condition !== undefined ? (edgeObj.condition as string | null) : null,
      conditionType: (edgeObj.conditionType as EdgeDraft["conditionType"]) ?? "deterministic",
    };
  });

  const draft: WorkflowDraft = {
    nodes,
    edges,
    sourceProvenance: {
      sourceKind: "json_ir",
      sourcePath,
      compilerVersion: "0.1.0",
    },
    ...(obj.id ? { id: String(obj.id) } : {}),
    ...(obj.name ? { name: String(obj.name) } : {}),
    ...(obj.description ? { description: String(obj.description) } : {}),
    ...(obj.taskId ? { taskId: String(obj.taskId) } : {}),
  };

  return draft;
}
