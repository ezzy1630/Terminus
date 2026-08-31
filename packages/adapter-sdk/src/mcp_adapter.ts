/**
 * @terminus/adapter-sdk — Model Context Protocol (MCP) Boundary Adapter.
 *
 * Per SPEC §9.3, §35.5:
 * Translates external Model Context Protocol tools, resources, and prompts
 * into canonical capability descriptors, resource handles, and bounded tool calls.
 */
import type { ResourceHandle } from "@terminus/domain";

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly mimeType?: string | undefined;
}

export interface McpPromptDescriptor {
  readonly name: string;
  readonly description?: string | undefined;
  readonly arguments?: readonly { readonly name: string; readonly description?: string; readonly required?: boolean }[] | undefined;
}

// skipcq: JS-0327
export class McpBoundaryAdapter {
  /**
   * Translates an MCP Tool descriptor into a canonical CapabilityDescriptor.
   */
  static toolToCapability(
    tool: McpToolDescriptor,
    serverName: string,
    trustLevel: "untrusted" | "verified_third_party" = "untrusted",
  ) {
    return {
      capabilityId: `mcp:${serverName}:${tool.name}`,
      kind: "mcp_tool",
      trustLevel,
      summary: tool.description,
      inputSchema: tool.inputSchema,
      serverName,
      attenuations: ["sandbox_egress", "bounded_output"],
    };
  }

  /**
   * Translates an MCP Resource descriptor into a canonical ResourceHandle.
   */
  static resourceToHandle(
    resource: McpResourceDescriptor,
    taskId: string,
    principal: string,
  ): ResourceHandle {
    return {
      objectId: `mcp_res:${resource.uri}`,
      objectType: "mcp_resource",
      version: 1,
      scope: [resource.uri],
      allowedOperations: ["read"],
      principalBinding: principal,
      taskBinding: taskId,
      authorityEpoch: 1,
      provenance: "mcp_resource_discovery",
      trustLabel: "UNTRUSTED_TOOL",
      expiry: null,
      integrityHash: `sha256:mcp_${resource.uri}`,
    };
  }

  /**
   * Formats a canonical tool call into an MCP tool invocation payload.
   */
  static canonicalToMcpInvocation(toolName: string, args: Record<string, unknown>) {
    return {
      name: toolName.replace(/^mcp:[^:]+:/, ""),
      arguments: args,
    };
  }
}
