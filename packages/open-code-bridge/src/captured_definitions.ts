/**
 * Captured Inherited OpenCode Provider Requests & Tool Definitions (SPEC §6.1).
 *
 * Stores exact provider request bodies, model concepts, and tool definition schemas
 * inherited from OpenCode to prevent drift and ensure renderer injection parity.
 */

export interface CapturedToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface CapturedProviderRequest {
  readonly provider: string;
  readonly model: string;
  readonly prompt: string;
  readonly systemPrompt?: string;
  readonly tools: readonly CapturedToolDefinition[];
  readonly maxTokens: number;
}

export const CAPTURED_DEFAULT_TOOLS: readonly CapturedToolDefinition[] = [
  {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read contents of a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "replace_file_content",
    description: "Replace exact text in a file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        targetContent: { type: "string" },
        replacementContent: { type: "string" },
      },
      required: ["path", "targetContent", "replacementContent"],
    },
  },
  {
    name: "list_dir",
    description: "List directory contents",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "grep_search",
    description: "Search pattern in files using ripgrep",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, searchPath: { type: "string" } },
      required: ["query", "searchPath"],
    },
  },
  {
    name: "invoke_subagent",
    description: "Invoke a specialized subagent for concurrent subtask execution",
    parameters: {
      type: "object",
      properties: { role: { type: "string" }, prompt: { type: "string" } },
      required: ["role", "prompt"],
    },
  },
  {
    name: "verification",
    description: "Execute verification command suite",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
];

export function captureProviderRequest(
  provider: string,
  model: string,
  prompt: string,
  tools: readonly CapturedToolDefinition[] = CAPTURED_DEFAULT_TOOLS
): CapturedProviderRequest {
  return {
    provider,
    model,
    prompt,
    systemPrompt: "You are Terminus AI agent.",
    tools,
    maxTokens: 8192,
  };
}
