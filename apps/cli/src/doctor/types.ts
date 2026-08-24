/**
 * Diagnostic types for `terminus doctor` (SPEC §42.1, ADR-0035, Roadmap Phase 0).
 */

export type ProbeStatus = "pass" | "warn" | "fail" | "skip";
export type SystemProfile = "native" | "governed" | "production" | "development";

export interface ProbeResult {
  readonly id: string;
  readonly name: string;
  readonly status: ProbeStatus;
  readonly message: string;
  readonly details?: Record<string, unknown> | string | undefined;
  readonly recommendation?: string | undefined;
  /** If true, failing this probe triggers a hard failure in production profile */
  readonly isProductionInvariant?: boolean | undefined;
}

export interface DoctorCategoryReport {
  readonly name: string;
  readonly title: string;
  readonly probes: readonly ProbeResult[];
}

export interface DoctorReportSummary {
  readonly total: number;
  readonly passed: number;
  readonly warned: number;
  readonly failed: number;
  readonly skipped: number;
  readonly status: "healthy" | "degraded" | "failing";
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly profile: SystemProfile;
  readonly platform: {
    readonly os: string;
    readonly arch: string;
    readonly nodeVersion: string;
    readonly bunVersion: string | null;
  };
  readonly summary: DoctorReportSummary;
  readonly categories: readonly DoctorCategoryReport[];
  readonly invariants: {
    readonly passed: boolean;
    readonly violations: readonly string[];
  };
}

export interface DoctorOptions {
  readonly profile?: SystemProfile | string | undefined;
  readonly gatewayUrl?: string | undefined;
  readonly verbose?: boolean | undefined;
}
