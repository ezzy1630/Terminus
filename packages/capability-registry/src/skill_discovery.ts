/**
 * Progressive skill discovery and body loading — SPEC §35.2, ADR-0017.
 *
 * Model sees only names + concise descriptions until a skill is selected.
 * Bodies load through a permission-checked path; scripts never run ambiently.
 */
import { z } from "zod";
import type {
  CapabilityDescriptor,
  CapabilityKind,
  CapabilityTrustLevel,
  ContentHash,
} from "@terminus/domain";
import { PermissionError, ValidationError, ConflictError } from "@terminus/domain";
import { asContentHash, contentHashOf } from "./hash.js";

export interface SkillSummary {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly trustLevel: CapabilityTrustLevel;
  readonly contentHash: ContentHash;
  readonly skillMdHash: ContentHash;
  readonly sourcePath: string;
}

export interface SkillBody {
  readonly summary: SkillSummary;
  readonly bodyMarkdown: string;
  readonly references: readonly string[];
  readonly scripts: readonly string[];
}

export interface SkillManifest {
  readonly id: string;
  readonly version: string;
  readonly skillMdHash: ContentHash;
  readonly compatibleHarness: string;
  readonly description: string;
  readonly requiredCapabilities: {
    readonly filesystem: { readonly read: readonly string[]; readonly write: readonly string[] };
    readonly network: readonly string[];
    readonly secrets: readonly string[];
    readonly tools?: readonly string[];
  };
  readonly tests: readonly string[];
  readonly provenance: {
    readonly source: string;
    readonly publisher: string;
    readonly signature: string | null;
    readonly trustLevel?: CapabilityTrustLevel;
  };
}

const skillManifestInnerSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  skill_md_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  compatible_harness: z.string().min(1),
  description: z.string().optional().default(""),
  required_capabilities: z.object({
    filesystem: z
      .object({
        read: z.array(z.string()).default([]),
        write: z.array(z.string()).default([]),
      })
      .default({ read: [], write: [] }),
    network: z.array(z.string()).default([]),
    secrets: z.array(z.string()).default([]),
    tools: z.array(z.string()).optional(),
  }),
  tests: z.array(z.string()).default([]),
  provenance: z.object({
    source: z.string(),
    publisher: z.string(),
    signature: z.string().nullable().optional().default(null),
    trust_level: z
      .enum(["builtin", "first_party", "verified_third_party", "untrusted"])
      .optional(),
  }),
});

export const skillManifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  skillMdHash: z.string() as unknown as z.ZodType<ContentHash>,
  compatibleHarness: z.string(),
  description: z.string(),
  requiredCapabilities: z.object({
    filesystem: z.object({ read: z.array(z.string()), write: z.array(z.string()) }),
    network: z.array(z.string()),
    secrets: z.array(z.string()),
    tools: z.array(z.string()).optional(),
  }),
  tests: z.array(z.string()),
  provenance: z.object({
    source: z.string(),
    publisher: z.string(),
    signature: z.string().nullable(),
    trustLevel: z
      .enum(["builtin", "first_party", "verified_third_party", "untrusted"])
      .optional(),
  }),
});

/**
 * Accepts either a flat manifest object or a `{ skill: ... }` / forge wrapper.
 * Also accepts camelCase test fixtures.
 */
export function loadSkillManifest(yaml: unknown): SkillManifest {
  if (yaml !== null && typeof yaml === "object" && "skillMdHash" in (yaml as object)) {
    return skillManifestSchema.parse(yaml) as SkillManifest;
  }
  const root = yaml as { skill?: unknown; forge?: { skill?: unknown } } | null;
  const inner = root?.skill ?? root?.forge?.skill ?? yaml;
  const parsed = skillManifestInnerSchema.parse(inner);
  return {
    id: parsed.id,
    version: parsed.version,
    skillMdHash: asContentHash(parsed.skill_md_hash),
    compatibleHarness: parsed.compatible_harness,
    description: parsed.description,
    requiredCapabilities: {
      filesystem: parsed.required_capabilities.filesystem,
      network: parsed.required_capabilities.network,
      secrets: parsed.required_capabilities.secrets,
      ...(parsed.required_capabilities.tools
        ? { tools: parsed.required_capabilities.tools }
        : {}),
    },
    tests: parsed.tests,
    provenance: {
      source: parsed.provenance.source,
      publisher: parsed.provenance.publisher,
      signature: parsed.provenance.signature ?? null,
      ...(parsed.provenance.trust_level
        ? { trustLevel: parsed.provenance.trust_level }
        : {}),
    },
  };
}

export function validateSkillMdHash(manifest: SkillManifest, skillMdBody: string): void {
  const actual = contentHashOf(skillMdBody);
  if (actual !== manifest.skillMdHash) {
    throw new ConflictSkillHashError(manifest.id, manifest.skillMdHash, actual);
  }
}

export class ConflictSkillHashError extends ConflictError {
  constructor(id: string, expected: ContentHash, actual: ContentHash) {
    super("DESCRIPTOR_RUG_PULL", `skill_md_hash mismatch for ${id}`, {
      id,
      expected,
      actual,
      code: "DESCRIPTOR_RUG_PULL",
    });
  }
}

export function trustFromManifest(manifest: SkillManifest): CapabilityTrustLevel {
  if (manifest.provenance.trustLevel) return manifest.provenance.trustLevel;
  if (manifest.provenance.signature) return "verified_third_party";
  return "untrusted";
}

export function manifestToDescriptor(
  manifest: SkillManifest,
  source: string,
  contentHash: ContentHash,
): CapabilityDescriptor {
  return {
    id: manifest.id,
    version: manifest.version,
    kind: "skill" as CapabilityKind,
    source,
    contentHash,
    signature: manifest.provenance.signature,
    publisher: manifest.provenance.publisher,
    trustLevel: trustFromManifest(manifest),
    entrypoint: null,
    operations: manifest.requiredCapabilities.tools ?? [],
    filesystem: {
      read: manifest.requiredCapabilities.filesystem.read,
      write: manifest.requiredCapabilities.filesystem.write,
    },
    network: { allow: manifest.requiredCapabilities.network },
    secrets: manifest.requiredCapabilities.secrets,
    subprocesses: {},
    externalState: {},
    resourceLimits: {},
    modelVisibility: { description: manifest.description },
    configurationSchema: null,
    compatibility: { compatibleHarness: manifest.compatibleHarness },
    lifecycle: { disableScripts: true, isolateEnvironment: true },
  };
}

export interface SkillSourceFiles {
  readonly sourcePath: string;
  /** Parsed terminus.skill.yaml / forge.skill.yaml object. */
  readonly manifestYaml: unknown;
  readonly skillMdBody: string;
  readonly referenceNames?: readonly string[];
  readonly scriptNames?: readonly string[];
}

export interface SkillDiscoveryIndex {
  readonly summaries: readonly SkillSummary[];
}

/**
 * Discover skills from supplied source records (caller enumerates the store).
 * Does not walk the ambient filesystem.
 */
export function discoverSkills(sources: readonly SkillSourceFiles[]): SkillDiscoveryIndex {
  const summaries: SkillSummary[] = [];
  for (const src of sources) {
    const manifest = loadSkillManifest(src.manifestYaml);
    validateSkillMdHash(manifest, src.skillMdBody);
    const name = extractSkillName(src.skillMdBody) ?? manifest.id;
    const description =
      manifest.description || extractSkillDescription(src.skillMdBody) || "";
    summaries.push({
      id: manifest.id,
      version: manifest.version,
      name,
      description,
      trustLevel: trustFromManifest(manifest),
      contentHash: contentHashOf(
        JSON.stringify({
          manifest: manifest.id,
          version: manifest.version,
          skillMdHash: manifest.skillMdHash,
        }),
      ),
      skillMdHash: manifest.skillMdHash,
      sourcePath: src.sourcePath,
    });
  }
  return { summaries };
}

/**
 * Load a skill body only after admission/activation checks pass.
 * Untrusted skill bodies remain labeled for the context compiler.
 */
export function loadSkillBody(
  source: SkillSourceFiles,
  opts: { readonly admitted: boolean; readonly activated: boolean },
): SkillBody {
  if (!opts.admitted) {
    throw new PermissionError("skill body load requires admitted capability", {
      path: source.sourcePath,
    });
  }
  if (!opts.activated) {
    throw new PermissionError("skill body load requires active capability", {
      path: source.sourcePath,
    });
  }
  const manifest = loadSkillManifest(source.manifestYaml);
  validateSkillMdHash(manifest, source.skillMdBody);
  const index = discoverSkills([source]);
  const summary = index.summaries[0];
  if (!summary) {
    throw new ValidationError("skill discovery produced no summary", {
      path: source.sourcePath,
    });
  }
  return {
    summary,
    bodyMarkdown: source.skillMdBody,
    references: source.referenceNames ?? [],
    scripts: source.scriptNames ?? [],
  };
}

function extractSkillName(md: string): string | null {
  const m = /^#\s+(.+)$/m.exec(md);
  return m?.[1]?.trim() ?? null;
}

function extractSkillDescription(md: string): string | null {
  const lines = md.split("\n").map((l) => l.trim());
  for (const line of lines) {
    if (line.startsWith("#") || line === "" || line.startsWith("---")) continue;
    return line.slice(0, 280);
  }
  return null;
}
