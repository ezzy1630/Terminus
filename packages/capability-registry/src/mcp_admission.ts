/**
 * MCP registration, tool-descriptor hashing, and re-admission — SPEC §35.4–35.5.
 */
import { z } from "zod";
import type { ContentHash, CapabilityTrustLevel } from "@terminus/domain";
import { ConflictError, PermissionError, ValidationError } from "@terminus/domain";
import { asContentHash, hashDescriptorPayload, stableStringify } from "./hash.js";
import type { LockfileEntry } from "./lockfile.js";

export const mcpTransportSchema = z.enum(["stdio", "streamable_http", "http"]);

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effectClass: "read_only" | "fs_mutate" | "network_egress" | "process_exec" | "secret_access";
}

export interface McpServerRegistration {
  readonly id: string;
  readonly version: string;
  readonly transport: "stdio" | "streamable_http" | "http";
  readonly commandOrUrl: string;
  readonly args?: readonly string[];
  readonly pinnedPackageOrImageDigest: ContentHash;
  readonly descriptorHash: ContentHash;
  readonly protocolVersion: string;
  readonly trustLevel: CapabilityTrustLevel;
  readonly sandboxProfile: string;
  readonly allowedToolIds: readonly string[];
  readonly filesystemScope: { readonly read: readonly string[]; readonly write: readonly string[] };
  readonly networkScope: readonly string[];
  readonly secretCapabilities: readonly string[];
  readonly rateLimits: { readonly requestsPerMinute: number; readonly burst: number };
  readonly outputLimits: { readonly maxOutputBytes: number; readonly maxArtifactBytes: number };
  readonly approvalPolicy: "always" | "on_first_use" | "pregranted";
  readonly tools: readonly McpToolDescriptor[];
  readonly signature: string | null;
  readonly publisher: string | null;
}

export interface AdmittedMcpServer {
  readonly registration: McpServerRegistration;
  readonly toolHashes: Readonly<Record<string, ContentHash>>;
  readonly descriptorHash: ContentHash;
  readonly admittedAt: string;
  readonly admittedBy: string;
}

const mcpToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  effectClass: z.enum([
    "read_only",
    "fs_mutate",
    "network_egress",
    "process_exec",
    "secret_access",
  ]),
});

export const mcpServerRegistrationSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  transport: mcpTransportSchema,
  commandOrUrl: z.string().min(1),
  args: z.array(z.string()).optional(),
  pinnedPackageOrImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  descriptorHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  protocolVersion: z.string().min(1),
  trustLevel: z.enum(["builtin", "first_party", "verified_third_party", "untrusted"]),
  sandboxProfile: z.string().min(1),
  allowedToolIds: z.array(z.string()),
  filesystemScope: z.object({
    read: z.array(z.string()),
    write: z.array(z.string()),
  }),
  networkScope: z.array(z.string()),
  secretCapabilities: z.array(z.string()),
  rateLimits: z.object({
    requestsPerMinute: z.number().int().nonnegative(),
    burst: z.number().int().nonnegative(),
  }),
  outputLimits: z.object({
    maxOutputBytes: z.number().int().nonnegative(),
    maxArtifactBytes: z.number().int().nonnegative(),
  }),
  approvalPolicy: z.enum(["always", "on_first_use", "pregranted"]),
  tools: z.array(mcpToolSchema),
  signature: z.string().nullable(),
  publisher: z.string().nullable(),
});

export function hashToolDescriptor(tool: McpToolDescriptor): ContentHash {
  return hashDescriptorPayload({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    effectClass: tool.effectClass,
  });
}

export function computeMcpDescriptorHash(
  registration: Omit<McpServerRegistration, "descriptorHash" | "tools"> & {
    readonly tools: readonly McpToolDescriptor[];
  },
): ContentHash {
  const toolHashes = Object.fromEntries(
    registration.tools.map((t) => [t.name, hashToolDescriptor(t)]),
  );
  return hashDescriptorPayload({
    id: registration.id,
    version: registration.version,
    transport: registration.transport,
    commandOrUrl: registration.commandOrUrl,
    args: registration.args ?? [],
    pinnedPackageOrImageDigest: registration.pinnedPackageOrImageDigest,
    protocolVersion: registration.protocolVersion,
    trustLevel: registration.trustLevel,
    sandboxProfile: registration.sandboxProfile,
    allowedToolIds: [...registration.allowedToolIds].sort(),
    filesystemScope: registration.filesystemScope,
    networkScope: [...registration.networkScope].sort(),
    secretCapabilities: [...registration.secretCapabilities].sort(),
    rateLimits: registration.rateLimits,
    outputLimits: registration.outputLimits,
    approvalPolicy: registration.approvalPolicy,
    toolHashes,
  });
}

export function parseMcpRegistration(raw: unknown): McpServerRegistration {
  const parsed = mcpServerRegistrationSchema.parse(raw) as unknown as McpServerRegistration;
  const computed = computeMcpDescriptorHash(parsed);
  if (parsed.descriptorHash !== computed) {
    throw new ValidationError("MCP descriptor_hash does not match tool set", {
      expected: computed,
      actual: parsed.descriptorHash,
    });
  }
  if (parsed.trustLevel === "verified_third_party" && parsed.signature === null) {
    throw new ValidationError("verified_third_party MCP servers require a signature", {
      id: parsed.id,
    });
  }
  // Untrusted MCP: no secret+process combo via tools.
  if (parsed.trustLevel === "untrusted") {
    const effects = new Set(parsed.tools.map((t) => t.effectClass));
    if (effects.has("process_exec") && effects.has("network_egress")) {
      throw new PermissionError(
        "untrusted MCP cannot expose both process_exec and network_egress tools",
        { id: parsed.id },
      );
    }
    if (effects.has("process_exec") && parsed.secretCapabilities.length > 0) {
      throw new PermissionError(
        "untrusted MCP cannot combine process_exec tools with secret capabilities",
        { id: parsed.id },
      );
    }
  }
  return parsed;
}

export interface McpAdmissionEvent {
  readonly kind: "admitted" | "descriptor_changed" | "tool_shadowing" | "reauthorization_required";
  readonly serverId: string;
  readonly detail: string;
  readonly beforeHash?: ContentHash;
  readonly afterHash?: ContentHash;
}

/**
 * Admit MCP tools against an existing lockfile entry. Detects rug-pulls,
 * tool-shadowing (same name, different hash), and scope expansions.
 */
export function admitMcpServer(
  registration: McpServerRegistration,
  prior: LockfileEntry | null,
  admittedBy: string,
  admittedAt: string,
): { readonly admitted: AdmittedMcpServer; readonly events: readonly McpAdmissionEvent[] } {
  const events: McpAdmissionEvent[] = [];
  const toolHashes: Record<string, ContentHash> = {};
  for (const tool of registration.tools) {
    if (!registration.allowedToolIds.includes(tool.name)) {
      throw new PermissionError("tool not in allowed_tool_ids", {
        serverId: registration.id,
        tool: tool.name,
      });
    }
    toolHashes[tool.name] = hashToolDescriptor(tool);
  }

  if (prior !== null) {
    if (prior.contentHash !== registration.pinnedPackageOrImageDigest) {
      events.push({
        kind: "descriptor_changed",
        serverId: registration.id,
        detail: "pinned package/image digest changed",
        beforeHash: prior.contentHash,
        afterHash: registration.pinnedPackageOrImageDigest,
      });
      throw new ConflictError(
        "DESCRIPTOR_RUG_PULL",
        `MCP ${registration.id}@${registration.version} package digest changed — re-authorization required`,
        { existing: prior.contentHash, incoming: registration.pinnedPackageOrImageDigest },
      );
    }
    if (prior.admissionFingerprint !== registration.descriptorHash) {
      events.push({
        kind: "reauthorization_required",
        serverId: registration.id,
        detail: "descriptor hash changed",
        beforeHash: prior.admissionFingerprint,
        afterHash: registration.descriptorHash,
      });
      throw new ConflictError(
        "DESCRIPTOR_RUG_PULL",
        `MCP ${registration.id}@${registration.version} descriptor changed — re-authorization required`,
        {
          existing: prior.admissionFingerprint,
          incoming: registration.descriptorHash,
        },
      );
    }
    for (const [name, hash] of Object.entries(toolHashes)) {
      const priorHash = prior.toolDescriptorHashes[name];
      if (priorHash !== undefined && priorHash !== hash) {
        events.push({
          kind: "tool_shadowing",
          serverId: registration.id,
          detail: `tool '${name}' schema/effect changed`,
          beforeHash: asContentHash(priorHash),
          afterHash: hash,
        });
        throw new ConflictError(
          "DESCRIPTOR_RUG_PULL",
          `MCP tool '${name}' descriptor mutated — re-authorization required`,
          { tool: name, existing: priorHash, incoming: hash },
        );
      }
    }
  }

  events.push({
    kind: "admitted",
    serverId: registration.id,
    detail: `admitted ${registration.tools.length} tool(s)`,
    afterHash: registration.descriptorHash,
  });

  return {
    admitted: {
      registration,
      toolHashes,
      descriptorHash: registration.descriptorHash,
      admittedAt,
      admittedBy,
    },
    events,
  };
}

/** Treat MCP descriptions/results as untrusted model input. */
export function labelUntrustedMcpText(
  text: string,
  serverId: string,
  contentHash: ContentHash,
): { readonly text: string; readonly trust: "untrusted"; readonly provenance: string } {
  return {
    text,
    trust: "untrusted",
    provenance: `mcp:${serverId}:${contentHash}`,
  };
}

export function mcpToolCallAuthorized(
  admitted: AdmittedMcpServer,
  toolName: string,
  expectedToolHash: ContentHash | null,
): void {
  if (!admitted.registration.allowedToolIds.includes(toolName)) {
    throw new PermissionError("MCP tool not admitted", {
      serverId: admitted.registration.id,
      toolName,
    });
  }
  const hash = admitted.toolHashes[toolName];
  if (hash === undefined) {
    throw new PermissionError("MCP tool descriptor missing from admission set", {
      serverId: admitted.registration.id,
      toolName,
    });
  }
  if (expectedToolHash !== null && expectedToolHash !== hash) {
    throw new ConflictError(
      "DESCRIPTOR_RUG_PULL",
      `live tool hash for '${toolName}' diverged from admitted hash`,
      { expected: expectedToolHash, live: hash },
    );
  }
}

export function summarizeMcpEffects(tools: readonly McpToolDescriptor[]): string {
  return stableStringify([...new Set(tools.map((t) => t.effectClass))].sort());
}
