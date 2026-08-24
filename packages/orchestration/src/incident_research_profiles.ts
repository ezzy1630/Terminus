/** In-memory profile coordinators. They record evidence; they do not run tools or notebooks. */
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  artifactUriSchema,
  contentHashSchema,
  generateUuid7,
  incidentExecutionRecordSchema,
  incidentProfileSpecSchema,
  nowTimestamp,
  researchProfileSpecSchema,
  researchProvenanceRecordSchema,
  type ArtifactUri,
  type ContentHash,
  type IncidentExecutionRecord,
  type IncidentProfileSpec,
  type ResearchProfileSpec,
  type ResearchProvenanceRecord,
} from "@terminus/domain";

export type { IncidentExecutionRecord, ResearchProvenanceRecord } from "@terminus/domain";

export class IncidentProfileRunner {
  private readonly profiles = new Map<string, IncidentProfileSpec>();
  private readonly executions = new Map<string, IncidentExecutionRecord>();

  public registerProfile(rawProfile: IncidentProfileSpec): void {
    incidentProfileSpecSchema.parse(rawProfile);
    const profile = rawProfile;
    const existing = this.profiles.get(profile.profileId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(profile)) {
      throw new ConflictError(
        "DESCRIPTOR_RUG_PULL",
        `Incident profile '${profile.profileId}' is already registered with different content`,
        { profileId: profile.profileId },
      );
    }
    this.profiles.set(profile.profileId, {
      ...profile,
      allowedDiagnostics: [...profile.allowedDiagnostics],
    });
  }

  public getProfile(profileId: string): IncidentProfileSpec | null {
    const profile = this.profiles.get(profileId);
    return profile === undefined
      ? null
      : { ...profile, allowedDiagnostics: [...profile.allowedDiagnostics] };
  }

  public startIncident(
    profileId: string,
    taskId: string,
    initialDiagnostics: readonly string[],
  ): IncidentExecutionRecord {
    const profile = this.requireProfile(profileId);
    this.assertDiagnosticsAllowed(profile, initialDiagnostics);
    const startedAt = nowTimestamp();
    const record: IncidentExecutionRecord = {
      executionId: generateUuid7(),
      taskId,
      profileId,
      diagnosticActions: [...initialDiagnostics],
      forensicAuditLog: [
        `[${startedAt}] Incident coordination started with audit level ${profile.auditLevel}`,
        ...initialDiagnostics.map((diagnostic) => `[${startedAt}] Diagnostic scheduled: ${diagnostic}`),
      ],
      compensationVerified: false,
      escalated: false,
      state: "active",
      startedAt,
      completedAt: null,
    };
    incidentExecutionRecordSchema.parse(record);
    this.executions.set(record.executionId, record);
    return this.copyIncident(record);
  }

  public recordDiagnosticAction(
    executionId: string,
    actionName: string,
    outputSummary: string,
    success: boolean,
  ): IncidentExecutionRecord {
    const record = this.requireExecution(executionId);
    if (record.state !== "active") {
      throw new ConflictError(
        "STATE_TRANSITION_INVALID",
        `Cannot record diagnostics after incident entered ${record.state}`,
      );
    }
    const profile = this.requireProfile(record.profileId);
    this.assertDiagnosticsAllowed(profile, [actionName]);
    const timestamp = nowTimestamp();
    const updated: IncidentExecutionRecord = {
      ...record,
      diagnosticActions: [...record.diagnosticActions, actionName],
      forensicAuditLog: [
        ...record.forensicAuditLog,
        `[${timestamp}] Diagnostic ${actionName}: ${success ? "passed" : "failed"}; ${outputSummary}`,
      ],
      escalated: record.escalated || (!success && profile.autoEscalateOnFailure),
    };
    incidentExecutionRecordSchema.parse(updated);
    this.executions.set(executionId, updated);
    return this.copyIncident(updated);
  }

  public completeIncident(
    executionId: string,
    compensationVerified: boolean,
  ): IncidentExecutionRecord {
    const record = this.requireExecution(executionId);
    if (record.state !== "active") {
      throw new ConflictError(
        "STATE_TRANSITION_INVALID",
        `Incident is already ${record.state}`,
        { executionId },
      );
    }
    const profile = this.requireProfile(record.profileId);
    const completedAt = nowTimestamp();
    const blocked = profile.mandatoryCompensation && !compensationVerified;
    const updated: IncidentExecutionRecord = {
      ...record,
      compensationVerified,
      escalated: record.escalated || blocked,
      state: blocked ? "blocked_compensation" : "resolved",
      completedAt: blocked ? null : completedAt,
      forensicAuditLog: [
        ...record.forensicAuditLog,
        blocked
          ? `[${completedAt}] Resolution blocked because compensation is unverified`
          : `[${completedAt}] Incident marked resolved`,
      ],
    };
    incidentExecutionRecordSchema.parse(updated);
    this.executions.set(executionId, updated);
    return this.copyIncident(updated);
  }

  private assertDiagnosticsAllowed(profile: IncidentProfileSpec, diagnostics: readonly string[]): void {
    const denied = diagnostics.find((diagnostic) => !profile.allowedDiagnostics.includes(diagnostic));
    if (denied !== undefined) {
      throw new PolicyDeniedError(`Diagnostic is not allowed by incident profile: ${denied}`, {
        profileId: profile.profileId,
        diagnostic: denied,
      });
    }
  }

  private requireProfile(profileId: string): IncidentProfileSpec {
    const profile = this.profiles.get(profileId);
    if (profile === undefined) throw new NotFoundError("incident profile", profileId);
    return profile;
  }

  private requireExecution(executionId: string): IncidentExecutionRecord {
    const record = this.executions.get(executionId);
    if (record === undefined) throw new NotFoundError("incident execution", executionId);
    return record;
  }

  private copyIncident(record: IncidentExecutionRecord): IncidentExecutionRecord {
    return {
      ...record,
      diagnosticActions: [...record.diagnosticActions],
      forensicAuditLog: [...record.forensicAuditLog],
    };
  }
}

export class ResearchProfileRunner {
  private readonly profiles = new Map<string, ResearchProfileSpec>();
  private readonly records = new Map<string, ResearchProvenanceRecord>();

  public registerProfile(rawProfile: ResearchProfileSpec): void {
    researchProfileSpecSchema.parse(rawProfile);
    const profile = rawProfile;
    const existing = this.profiles.get(profile.profileId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(profile)) {
      throw new ConflictError(
        "DESCRIPTOR_RUG_PULL",
        `Research profile '${profile.profileId}' is already registered with different content`,
        { profileId: profile.profileId },
      );
    }
    this.profiles.set(profile.profileId, { ...profile });
  }

  public getProfile(profileId: string): ResearchProfileSpec | null {
    const profile = this.profiles.get(profileId);
    return profile === undefined ? null : { ...profile };
  }

  public startResearch(profileId: string, taskId: string): ResearchProvenanceRecord {
    this.requireProfile(profileId);
    const record: ResearchProvenanceRecord = {
      researchId: generateUuid7(),
      taskId,
      profileId,
      sourcesConsulted: [],
      notebookOutputs: [],
      hypotheses: [],
      createdAt: nowTimestamp(),
    };
    researchProvenanceRecordSchema.parse(record);
    this.records.set(record.researchId, record);
    return this.copyResearch(record);
  }

  public addSource(
    researchId: string,
    title: string,
    uri: string,
    rawHash: string,
  ): ResearchProvenanceRecord {
    const record = this.requireRecord(researchId);
    const profile = this.requireProfile(record.profileId);
    if (record.sourcesConsulted.length >= profile.maxSearchQueries) {
      throw new PolicyDeniedError("Research source limit reached", {
        profileId: profile.profileId,
        maxSearchQueries: profile.maxSearchQueries,
      });
    }
    if (!profile.allowMultiSourceRetrieval && record.sourcesConsulted.length > 0) {
      throw new PolicyDeniedError("Research profile allows only one source", {
        profileId: profile.profileId,
      });
    }
    contentHashSchema.parse(rawHash);
    const hash = rawHash as ContentHash;
    const sourceId = generateUuid7();
    const citation = this.formatCitation(profile, record.sourcesConsulted.length + 1, title, uri, hash);
    const updated: ResearchProvenanceRecord = {
      ...record,
      sourcesConsulted: [
        ...record.sourcesConsulted,
        { sourceId, title, uri, hash, citation },
      ],
    };
    researchProvenanceRecordSchema.parse(updated);
    this.records.set(researchId, updated);
    return this.copyResearch(updated);
  }

  public addNotebookCellOutput(
    researchId: string,
    cellIndex: number,
    codeSnippet: string,
    resultSummary: string,
    rawArtifactRef: string,
  ): ResearchProvenanceRecord {
    const record = this.requireRecord(researchId);
    const profile = this.requireProfile(record.profileId);
    if (!profile.notebookSandboxEnabled) {
      throw new PolicyDeniedError("Research profile does not allow notebook execution", {
        profileId: profile.profileId,
      });
    }
    artifactUriSchema.parse(rawArtifactRef);
    const artifactRef = rawArtifactRef as ArtifactUri;
    const updated: ResearchProvenanceRecord = {
      ...record,
      notebookOutputs: [
        ...record.notebookOutputs,
        { cellIndex, codeSnippet, resultSummary, artifactRef },
      ],
    };
    researchProvenanceRecordSchema.parse(updated);
    this.records.set(researchId, updated);
    return this.copyResearch(updated);
  }

  public recordHypothesis(
    researchId: string,
    statement: string,
    outcome: "confirmed" | "refuted" | "inconclusive",
  ): ResearchProvenanceRecord {
    const record = this.requireRecord(researchId);
    const updated: ResearchProvenanceRecord = {
      ...record,
      hypotheses: [...record.hypotheses, { statement, outcome }],
    };
    researchProvenanceRecordSchema.parse(updated);
    this.records.set(researchId, updated);
    return this.copyResearch(updated);
  }

  public getRecord(researchId: string): ResearchProvenanceRecord | null {
    const record = this.records.get(researchId);
    return record === undefined ? null : this.copyResearch(record);
  }

  private formatCitation(
    profile: ResearchProfileSpec,
    ordinal: number,
    title: string,
    uri: string,
    hash: ContentHash,
  ): string {
    if (profile.citationFormat === "ieee") {
      return `[${ordinal}] ${title}. ${uri}. Integrity: ${hash}`;
    }
    if (profile.citationFormat === "apa") {
      return `${title}. Retrieved from ${uri}. Integrity: ${hash}`;
    }
    return `[${title}](${uri}) (integrity: ${hash})`;
  }

  private requireProfile(profileId: string): ResearchProfileSpec {
    const profile = this.profiles.get(profileId);
    if (profile === undefined) throw new NotFoundError("research profile", profileId);
    return profile;
  }

  private requireRecord(researchId: string): ResearchProvenanceRecord {
    const record = this.records.get(researchId);
    if (record === undefined) throw new NotFoundError("research record", researchId);
    return record;
  }

  private copyResearch(record: ResearchProvenanceRecord): ResearchProvenanceRecord {
    return {
      ...record,
      sourcesConsulted: record.sourcesConsulted.map((source) => ({ ...source })),
      notebookOutputs: record.notebookOutputs.map((output) => ({ ...output })),
      hypotheses: record.hypotheses.map((hypothesis) => ({ ...hypothesis })),
    };
  }
}
