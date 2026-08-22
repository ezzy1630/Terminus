/**
 * Concrete external harness adapters — Codex, Pi, Claude Code (third).
 *
 * Phase 0 honesty (roadmap.md): every shipped runner except the fixture
 * agent is a contract stub — it speaks the protocol but does not launch a
 * real inner harness and has never been probed live. They are declared
 * `maturity: "stub"` with `lastVerified: null`; the registry rejects any
 * production claim that lacks probe evidence.
 */
import type { Rfc3339Timestamp } from "@terminus/domain";
import { StdioJsonRpcAdapter, type AdapterProcessPort } from "./stdio_adapter.js";
import type { AdapterCapabilityProfile, AdapterMaturity, ExternalAdapter } from "./types.js";

function profile(
  partial: Omit<
    AdapterCapabilityProfile,
    "observedByProbe" | "lastVerified" | "maturity"
  >,
  maturity: AdapterMaturity,
  probedAt: Rfc3339Timestamp | null = null,
): AdapterCapabilityProfile {
  return {
    ...partial,
    maturity,
    observedByProbe: probedAt,
    lastVerified: probedAt,
  };
}

export const CODEX_DECLARED_PROFILE = profile({
  exactContextVisibility: "partial",
  toolInterception: "partial",
  filesystemEnforcement: "outer_sandbox",
  networkEnforcement: "outer_sandbox",
  secretIsolation: "outer_broker",
  sessionResume: "native",
  typedResults: "native",
  artifactExport: "partial",
  cancellation: "reliable",
  modelSelection: "constrained",
  nativeCompaction: true,
}, "stub");

export const PI_DECLARED_PROFILE = profile({
  exactContextVisibility: "partial",
  toolInterception: "partial",
  filesystemEnforcement: "outer_sandbox",
  networkEnforcement: "outer_sandbox",
  secretIsolation: "outer_broker",
  sessionResume: "emulated",
  typedResults: "parsed",
  artifactExport: "partial",
  cancellation: "best_effort",
  modelSelection: "constrained",
  nativeCompaction: false,
}, "stub");

export const CLAUDE_CODE_DECLARED_PROFILE = profile({
  exactContextVisibility: "partial",
  toolInterception: "partial",
  filesystemEnforcement: "outer_sandbox",
  networkEnforcement: "outer_sandbox",
  secretIsolation: "outer_broker",
  sessionResume: "native",
  typedResults: "native",
  artifactExport: "partial",
  cancellation: "reliable",
  modelSelection: "constrained",
  nativeCompaction: true,
}, "stub");

export const FIXTURE_DECLARED_PROFILE = profile({
  exactContextVisibility: "full",
  toolInterception: "full",
  filesystemEnforcement: "native",
  networkEnforcement: "native",
  secretIsolation: "native",
  sessionResume: "native",
  typedResults: "native",
  artifactExport: "complete",
  cancellation: "reliable",
  modelSelection: "controlled",
  nativeCompaction: false,
}, "fixture");

export function createCodexAdapter(
  port: AdapterProcessPort,
  clock: () => Rfc3339Timestamp,
  command = "codex-adapter",
  args: readonly string[] = [],
): ExternalAdapter {
  return new StdioJsonRpcAdapter(
    "codex",
    "0.1.0",
    CODEX_DECLARED_PROFILE,
    command,
    args,
    port,
    clock,
  );
}

export function createPiAdapter(
  port: AdapterProcessPort,
  clock: () => Rfc3339Timestamp,
  command = "pi-adapter",
  args: readonly string[] = [],
): ExternalAdapter {
  return new StdioJsonRpcAdapter("pi", "0.1.0", PI_DECLARED_PROFILE, command, args, port, clock);
}

export function createClaudeCodeAdapter(
  port: AdapterProcessPort,
  clock: () => Rfc3339Timestamp,
  command = "claude-code-adapter",
  args: readonly string[] = [],
): ExternalAdapter {
  return new StdioJsonRpcAdapter(
    "claude-code",
    "0.1.0",
    CLAUDE_CODE_DECLARED_PROFILE,
    command,
    args,
    port,
    clock,
  );
}

export function createFixtureAgentAdapter(
  port: AdapterProcessPort,
  clock: () => Rfc3339Timestamp,
  command = "bun",
  args: readonly string[] = ["run", "adapters/fixture-agent/runner.ts"],
): ExternalAdapter {
  return new StdioJsonRpcAdapter(
    "fixture-agent",
    "0.1.0",
    FIXTURE_DECLARED_PROFILE,
    command,
    args,
    port,
    clock,
  );
}
