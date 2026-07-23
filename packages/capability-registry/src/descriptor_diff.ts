/**
 * Descriptor mutation diffs — SPEC §35.5.
 *
 * A changed descriptor, schema, server version, package digest, or requested
 * scope invalidates prior authorization. Diffs are structural and hashed.
 */
import type { CapabilityDescriptor, ContentHash } from "@terminus/domain";
import { hashDescriptorPayload, stableStringify } from "./hash.js";

export type DescriptorField =
  | "contentHash"
  | "version"
  | "signature"
  | "trustLevel"
  | "entrypoint"
  | "operations"
  | "filesystem"
  | "network"
  | "secrets"
  | "subprocesses"
  | "resourceLimits"
  | "toolSchemas"
  | "effectClassification"
  | "lifecycle"
  | "compatibility";

export interface DescriptorMutation {
  readonly field: DescriptorField;
  readonly before: unknown;
  readonly after: unknown;
}

export interface DescriptorDiff {
  readonly id: string;
  readonly version: string;
  readonly mutations: readonly DescriptorMutation[];
  readonly requiresReauthorization: boolean;
  readonly beforeHash: ContentHash;
  readonly afterHash: ContentHash;
}

const EFFECT_FIELDS: readonly DescriptorField[] = [
  "contentHash",
  "signature",
  "trustLevel",
  "entrypoint",
  "operations",
  "filesystem",
  "network",
  "secrets",
  "subprocesses",
  "resourceLimits",
  "toolSchemas",
  "effectClassification",
  "lifecycle",
] as const;

function fieldValue(d: CapabilityDescriptor, field: DescriptorField): unknown {
  switch (field) {
    case "contentHash":
      return d.contentHash;
    case "version":
      return d.version;
    case "signature":
      return d.signature;
    case "trustLevel":
      return d.trustLevel;
    case "entrypoint":
      return d.entrypoint;
    case "operations":
      return d.operations;
    case "filesystem":
      return d.filesystem;
    case "network":
      return d.network;
    case "secrets":
      return d.secrets;
    case "subprocesses":
      return d.subprocesses;
    case "resourceLimits":
      return d.resourceLimits;
    case "toolSchemas":
      return d.toolSchemas ?? null;
    case "effectClassification":
      return d.effectClassification ?? null;
    case "lifecycle":
      return d.lifecycle ?? null;
    case "compatibility":
      return d.compatibility;
  }
}

export function diffDescriptors(
  before: CapabilityDescriptor,
  after: CapabilityDescriptor,
): DescriptorDiff {
  const mutations: DescriptorMutation[] = [];
  for (const field of EFFECT_FIELDS) {
    const b = fieldValue(before, field);
    const a = fieldValue(after, field);
    if (stableStringify(b) !== stableStringify(a)) {
      mutations.push({ field, before: b, after: a });
    }
  }
  if (before.version !== after.version) {
    mutations.push({ field: "version", before: before.version, after: after.version });
  }
  return {
    id: after.id,
    version: after.version,
    mutations,
    requiresReauthorization: mutations.length > 0,
    beforeHash: before.contentHash,
    afterHash: after.contentHash,
  };
}

export function admissionFingerprint(descriptor: CapabilityDescriptor): ContentHash {
  return hashDescriptorPayload({
    id: descriptor.id,
    version: descriptor.version,
    kind: descriptor.kind,
    contentHash: descriptor.contentHash,
    trustLevel: descriptor.trustLevel,
    entrypoint: descriptor.entrypoint,
    operations: descriptor.operations,
    filesystem: descriptor.filesystem,
    network: descriptor.network,
    secrets: descriptor.secrets,
    subprocesses: descriptor.subprocesses,
    resourceLimits: descriptor.resourceLimits,
    toolSchemas: descriptor.toolSchemas ?? null,
    effectClassification: descriptor.effectClassification ?? null,
    lifecycle: descriptor.lifecycle ?? null,
  });
}
