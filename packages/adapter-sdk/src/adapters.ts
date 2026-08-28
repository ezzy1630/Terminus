/**
 * Concrete external harness adapters.
 *
 * Terminus drives models with its own loop; it does not delegate tasks to
 * other coding harnesses. The only shipped adapter is the deterministic
 * fixture agent used by conformance and exit-gate tests. Its profile is
 * declared `maturity: "fixture"` and the registry rejects any production
 * claim that lacks probe evidence.
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
