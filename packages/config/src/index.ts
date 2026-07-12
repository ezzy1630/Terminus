/**
 * @forge/config — layered typed configuration.
 *
 * Per SPEC Appendix F: configuration is layered in the order:
 *   compiled secure defaults
 *   < organization policy
 *   < user configuration
 *   < workspace configuration
 *   < session/task configuration
 *
 * Lower layers cannot weaken non-overridable controls.
 */
import { z } from "zod";
import {
  ForgeError,
  ValidationError,
} from "@forge/domain";

// ────────────────────────── Layer tags ───────────────────────────────────────

export const ConfigLayer = {
  COMPILED_DEFAULTS: "compiled_defaults",
  ORGANIZATION: "organization",
  USER: "user",
  WORKSPACE: "workspace",
  SESSION: "session",
  TASK: "task",
} as const;
export type ConfigLayer = (typeof ConfigLayer)[keyof typeof ConfigLayer];
export const configLayerSchema = z.enum([
  "compiled_defaults",
  "organization",
  "user",
  "workspace",
  "session",
  "task",
]);

export const LAYER_PRIORITY: Readonly<Record<ConfigLayer, number>> = {
  compiled_defaults: 0,
  organization: 1,
  user: 2,
  workspace: 3,
  session: 4,
  task: 5,
} as const;

// ────────────────────────── Top-level schema ─────────────────────────────────

export const telemetryConfigSchema = z.object({
  mode: z.enum(["local_only", "export"]).default("local_only"),
  exportEndpoint: z.string().nullable().default(null),
  includeContent: z.boolean().default(false),
});

export const publicApiConfigSchema = z.object({
  listen: z.object({
    unixSocket: z.string().nullable().default(null),
    loopbackHttp: z.string().nullable().default(null),
    remote: z.string().nullable().default(null),
  }),
  authentication: z.object({
    localTokenFile: z.string().nullable().default(null),
  }),
  eventRetention: z.object({
    maxEvents: z.number().int().positive().default(100_000),
    maxAgeDays: z.number().int().positive().default(30),
  }),
});

export const kernelConfigSchema = z.object({
  socket: z.string(),
  binary: z.string().default("forge-kernel"),
  requiredProtocol: z.string().default("1.x"),
  capabilityTokenTtlSeconds: z.number().int().positive().default(60),
  maxMessageBytes: z.number().int().positive().default(4_194_304),
});

export const storageConfigSchema = z.object({
  sqlite: z.string(),
  artifacts: z.string(),
  walCheckpointIntervalSeconds: z.number().int().positive().default(60),
  artifactCompression: z.enum(["none", "zstd", "gzip", "br"]).default("zstd"),
  garbageCollection: z.object({
    enabled: z.boolean().default(true),
    dryRun: z.boolean().default(false),
    intervalHours: z.number().int().positive().default(24),
  }),
});

export const providerAccountConfigSchema = z.object({
  adapter: z.string(),
  credential: z.string().nullable().default(null),
  retentionMode: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  baseUrl: z.string().nullable().default(null),
});

export const providersConfigSchema = z.object({
  policy: z.object({
    allowedConfidentiality: z
      .record(z.string(), z.array(z.string()))
      .default({ workspace: [], secret_adjacent: [] }),
  }),
  accounts: z.record(z.string(), providerAccountConfigSchema).default({}),
});

export const modelProfileRequirementsSchema = z.object({
  codingQuality: z.enum(["low", "medium", "high"]).nullable().default(null),
  toolReliability: z.enum(["low", "medium", "high"]).nullable().default(null),
  structuredOutput: z.enum(["required", "optional", "none"]).nullable().default(null),
  context: z.enum(["small", "medium", "large"]).nullable().default(null),
  securityReasoning: z.enum(["low", "medium", "high"]).nullable().default(null),
  highRecall: z.boolean().nullable().default(null),
});

export const modelProfilePreferencesSchema = z.object({
  latency: z.enum(["low", "medium", "high"]).nullable().default(null),
  cost: z.enum(["low", "medium", "high"]).nullable().default(null),
  providerDiversity: z.enum(["neutral", "prefer_diverse"]).nullable().default(null),
  differentFamilyFromImplementer: z.boolean().nullable().default(null),
});

export const modelProfileSchema = z.object({
  requirements: modelProfileRequirementsSchema,
  preferences: modelProfilePreferencesSchema,
  hardInputTokens: z.number().int().positive().nullable().default(null),
});

export const routingConfigSchema = z.object({
  mode: z.enum(["deterministic", "learned"]).default("deterministic"),
  maxProviderAttemptsPerTurn: z.number().int().positive().default(3),
  escalateAfter: z.object({
    repeatedToolFailures: z.number().int().positive().default(2),
    verificationRepairs: z.number().int().positive().default(2),
    explicitLowConfidence: z.boolean().default(true),
  }),
  learnedRouter: z.object({ enabled: z.boolean().default(false) }),
});

export const retrievalConfigSchema = z.object({
  lexical: z.boolean().default(true),
  treeSitter: z.boolean().default(true),
  lsp: z.boolean().default(true),
  dependencyGraph: z.boolean().default(true),
  semantic: z.object({ enabled: z.boolean().default(false) }),
});

export const compactionConfigSchema = z.object({
  semanticBoundaries: z.boolean().default(true),
  projectedContextThreshold: z.number().min(0).max(1).default(0.72),
  validateCheckpoint: z.boolean().default(true),
});

export const contextConfigSchema = z.object({
  compilerVersion: z.string().default("v1"),
  hardSafetyMarginTokens: z.number().int().positive().default(8192),
  evidenceCoverage: z.boolean().default(true),
  recentEpisodePolicy: z.object({
    mode: z.enum(["fixed", "adaptive"]).default("adaptive"),
    minimumCompleteEpisodes: z.number().int().nonnegative().default(2),
    maximumCompleteEpisodes: z.number().int().positive().default(10),
  }),
  retrieval: retrievalConfigSchema,
  compaction: compactionConfigSchema,
  memory: z.object({ enabled: z.boolean().default(false) }),
  externalCompression: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().nullable().default(null),
    shadowMode: z.boolean().default(true),
  }),
});

export const aciExecConfigSchema = z.object({
  defaultTimeoutMs: z.number().int().positive().default(30_000),
  shellRequiresPrompt: z.boolean().default(true),
});

export const aciPatchConfigSchema = z.object({
  defaultValidationProfile: z.string().default("language_fast"),
  allowTransientInvalidState: z.enum(["never", "isolated_only", "always"]).default("isolated_only"),
});

export const aciSearchConfigSchema = z.object({
  defaultLimit: z.number().int().positive().default(20),
  hardLimit: z.number().int().positive().default(100),
});

export const aciConfigSchema = z.object({
  defaultTools: z
    .array(z.string())
    .default(["read", "search", "patch", "exec", "job", "inspect", "capability"]),
  maximumModelResultBytes: z.number().int().positive().default(32_768),
  maximumRawToolArtifactBytes: z.number().int().positive().default(268_435_456),
  exec: aciExecConfigSchema,
  patch: aciPatchConfigSchema,
  search: aciSearchConfigSchema,
});

export const sandboxProfileConfigSchema = z.object({
  backend: z.enum(["auto", "linux", "macos", "windows", "container", "microvm"]).default("auto"),
  requireFullEnforcement: z.boolean().default(true),
  filesystem: z.object({
    read: z.array(z.string()).default([]),
    write: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }),
  network: z.object({
    direct: z.enum(["allow", "deny"]).default("deny"),
    proxy: z.enum(["required", "optional", "deny"]).default("required"),
    allow: z.array(z.string()).default([]),
  }),
  process: z.object({
    maxPids: z.number().int().positive().default(256),
    memoryBytes: z.number().int().positive().default(2_147_483_648),
    cpuSeconds: z.number().int().positive().default(600),
    openFiles: z.number().int().positive().default(1024),
  }),
  secrets: z.object({ directEnvironment: z.enum(["allow", "deny"]).default("deny") }),
});

export const policiesConfigSchema = z.object({
  command: z.string().default("policies/command/default.yaml"),
  network: z.string().default("policies/network/default.yaml"),
  secrets: z.string().default("policies/secrets/default.yaml"),
  approval: z.object({
    externalState: z.enum(["prompt", "deny", "allow"]).default("prompt"),
    secretUse: z.enum(["prompt_unless_pregranted", "prompt", "deny"]).default("prompt_unless_pregranted"),
    scopeExpansion: z.enum(["prompt", "deny", "allow"]).default("prompt"),
  }),
});

export const orchestrationConfigSchema = z.object({
  default: z.enum(["single_agent", "parallel_writers"]).default("single_agent"),
  scouts: z.object({
    enabled: z.boolean().default(true),
    readOnly: z.boolean().default(true),
  }),
  writers: z.object({
    enabled: z.boolean().default(true),
    requirePositiveExpectedValue: z.boolean().default(true),
    maxParallel: z.number().int().positive().default(2),
  }),
  reviewer: z.object({ riskTriggered: z.boolean().default(true) }),
  loopProtection: z.object({
    repeatedIdenticalFailure: z.number().int().positive().default(3),
    editRevertCycles: z.number().int().positive().default(2),
    turnsWithoutProgress: z.number().int().positive().default(8),
    maximumTurns: z.number().int().positive().default(50),
  }),
});

export const verificationConfigSchema = z.object({
  profiles: z
    .record(
      z.string(),
      z.object({
        required: z.array(z.string()).default([]),
        optional: z.array(z.string()).default([]),
      }),
    )
    .default({}),
});

export const extensionsConfigSchema = z.object({
  installation: z.object({
    lifecycleScripts: z.enum(["allow", "deny"]).default("deny"),
    requireLockfile: z.boolean().default(true),
    requireSignatureForVerified: z.boolean().default(true),
  }),
  thirdParty: z.object({
    execution: z.enum(["wasi_or_process", "in_process", "deny"]).default("wasi_or_process"),
    inProcess: z.enum(["allow", "deny"]).default("deny"),
  }),
  mcp: z.object({
    descriptorChange: z.enum(["require_reauthorization", "allow", "deny"]).default("require_reauthorization"),
    defaultNetwork: z.enum(["allow", "deny"]).default("deny"),
  }),
});

export const budgetsConfigSchema = z.object({
  task: z.object({
    modelMicrosSoft: z.number().int().positive().default(5_000_000),
    modelMicrosHard: z.number().int().positive().default(20_000_000),
    wallClockSecondsHard: z.number().int().positive().default(3600),
    humanApprovalsHard: z.number().int().positive().default(20),
  }),
  session: z.object({
    modelMicrosHard: z.number().int().positive().default(100_000_000),
  }),
});

export const forgeConfigSchema = z.object({
  version: z.literal(1).default(1),
  dataDir: z.string().default("~/.local/share/forge"),
  runtimeDir: z.string().default("~/.local/run/forge"),
  logLevel: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  telemetry: telemetryConfigSchema,
  publicApi: publicApiConfigSchema,
  kernel: kernelConfigSchema,
  storage: storageConfigSchema,
  providers: providersConfigSchema,
  modelProfiles: z.record(z.string(), modelProfileSchema).default({}),
  routing: routingConfigSchema,
  context: contextConfigSchema,
  aci: aciConfigSchema,
  sandboxProfiles: z.record(z.string(), sandboxProfileConfigSchema).default({
    "secure-local-default": sandboxProfileConfigSchema.parse({}),
  }),
  policies: policiesConfigSchema,
  orchestration: orchestrationConfigSchema,
  verification: verificationConfigSchema,
  extensions: extensionsConfigSchema,
  budgets: budgetsConfigSchema,
});

export type ForgeConfig = z.infer<typeof forgeConfigSchema>;

// ────────────────────────── Layered config loader ────────────────────────────

export interface ConfigSource {
  readonly layer: ConfigLayer;
  /** Parsed but untrusted config object (partial). */
  readonly value: Readonly<Record<string, unknown>>;
  /** Field paths that this layer may NOT weaken (e.g., sandbox.deny). */
  readonly nonOverridable?: readonly string[] | undefined;
  readonly origin: string;
}

export interface LayeredConfigResult {
  readonly config: ForgeConfig;
  readonly provenance: Readonly<Record<string, ConfigLayer>>;
  readonly warnings: readonly string[];
}

/** Compile-secure defaults. Always present, always layer 0. */
export function compiledDefaults(): Readonly<Record<string, unknown>> {
  return forgeConfigSchema.parse({}) as unknown as Readonly<Record<string, unknown>>;
}

/**
 * Merge a sequence of config layers. Higher layers override lower layers,
 * except for `nonOverridable` paths which may not be weakened (loosened) by
 * higher layers.
 *
 * "Weakening" means: turning a `deny` into `allow`, reducing a numeric limit,
 * or removing a deny-list entry. The function returns warnings for attempted
 * weakenings and leaves the lower-layer value in place.
 */
export function mergeConfigLayers(sources: readonly ConfigSource[]): LayeredConfigResult {
  const sorted = [...sources].sort(
    (a, b) => LAYER_PRIORITY[a.layer] - LAYER_PRIORITY[b.layer],
  );
  let merged: Record<string, unknown> = {};
  const provenance: Record<string, ConfigLayer> = {};
  const warnings: string[] = [];
  const lockedWeakenPaths = new Set<string>();

  for (const src of sorted) {
    const before = structuredCloneSafe(merged);
    merged = deepMerge(merged, src.value);
    // Re-establish provenance for any newly-set path.
    for (const path of flattenPaths(src.value)) {
      provenance[path] = src.layer;
    }
    // Enforce non-overridable.
    if (src.nonOverridable) {
      for (const path of src.nonOverridable) {
        lockedWeakenPaths.add(path);
      }
    }
    // Check weaken attempts.
    for (const path of lockedWeakenPaths) {
      if (isWeakened(getPath(before, path), getPath(merged, path))) {
        warnings.push(
          `${src.layer} (${src.origin}) attempted to weaken non-overridable path '${path}'; reverted.`,
        );
        setPath(merged, path, getPath(before, path));
      }
    }
  }

  let config: ForgeConfig;
  try {
    config = forgeConfigSchema.parse(merged);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new ValidationError("config validation failed", {
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    throw err;
  }
  return { config, provenance, warnings };
}

/** Loads configuration from a single source. */
export function loadConfig(source: ConfigSource): LayeredConfigResult {
  return mergeConfigLayers([
    { layer: "compiled_defaults", value: compiledDefaults(), origin: "compiled" },
    source,
  ]);
}

// ────────────────────────── Merge helpers ────────────────────────────────────

function deepMerge(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === null || v === undefined) continue;
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(
        out[k] as Readonly<Record<string, unknown>>,
        v as Readonly<Record<string, unknown>>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

function flattenPaths(obj: Readonly<Record<string, unknown>>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenPaths(v as Readonly<Record<string, unknown>>, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  if (!path) return;
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const next = cur[p];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * Returns true if `next` weakens `prev`. A weakening is:
 *  - `deny` -> `allow` for strings,
 *  - a strictly smaller numeric value (for limits),
 *  - a shorter array (for deny-lists).
 */
function isWeakened(prev: unknown, next: unknown): boolean {
  if (prev === undefined || next === undefined) return false;
  if (typeof prev === "string" && typeof next === "string") {
    if (prev === "deny" && (next === "allow" || next === "optional")) return true;
    if (prev === "required" && next === "optional") return true;
    return false;
  }
  if (typeof prev === "number" && typeof next === "number") {
    return next < prev;
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    return next.length < prev.length;
  }
  return false;
}

function structuredCloneSafe<T>(v: T): T {
  if (typeof structuredClone === "function") return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

export { ForgeError };
