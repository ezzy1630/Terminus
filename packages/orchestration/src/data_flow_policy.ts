/** Pure data-flow policy decisions. Filesystem and clipboard effects stay in the kernel. */
import {
  ConflictError,
  PolicyDeniedError,
  ValidationError,
  dataFlowCheckResultSchema,
  dataFlowPolicySchema,
  dataTransferAuditSchema,
  artifactUriSchema,
  contentHashSchema,
  generateUuid7,
  nowTimestamp,
  type ByteCount,
  type ContentHash,
  type DataFlowCheckResult,
  type DataFlowPolicy,
  type DataTransferAudit,
} from "@terminus/domain";

export type { DataFlowCheckResult } from "@terminus/domain";

export interface ContentArtifactIdentity {
  readonly artifactId: string;
  readonly contentHash: ContentHash;
}

export interface DlpScanReceipt extends ContentArtifactIdentity {
  /** Immutable evidence emitted by the scanner, not the scanned artifact itself. */
  readonly receiptArtifactId: string;
  /** Required for quarantine scans so the scan binds the destination proof. */
  readonly destinationEvidenceArtifactId: string | null;
  readonly scannerVersion: string;
  readonly passed: boolean;
}

export interface DownloadQuarantineReceipt {
  readonly source: ContentArtifactIdentity;
  readonly destination: ContentArtifactIdentity & {
    readonly quarantinedPath: string;
    readonly evidenceArtifactId: string;
  };
  readonly dlpScan: DlpScanReceipt;
}

const IMMUTABLE_ARTIFACT_PATTERN = /^artifact:\/\/sha256\/[0-9a-f]{64}$/;

export class DataFlowPolicyEngine {
  private readonly policies = new Map<string, DataFlowPolicy>();
  private readonly audits: DataTransferAudit[] = [];

  private readonly dlpSecretPatterns: readonly RegExp[] = [
    /AKIA[0-9A-Z]{16}/,
    /ghp_[a-zA-Z0-9]{36}/,
    /gho_[a-zA-Z0-9]{36}/,
    /xox[baprs]-[0-9a-zA-Z]{10,48}/,
    /sk-[a-zA-Z0-9]{32,64}/,
    /-----BEGIN (RSA|EC|OPENSSH|PRIVATE) KEY-----/,
    /canary_[0-9a-f]{16,32}/,
  ];

  public registerPolicy(rawPolicy: DataFlowPolicy): void {
    dataFlowPolicySchema.parse(rawPolicy);
    const policy = rawPolicy;
    const existing = this.policies.get(policy.policyId);
    if (existing !== undefined && !this.samePolicy(existing, policy)) {
      throw new ConflictError(
        "DESCRIPTOR_RUG_PULL",
        `Data-flow policy '${policy.policyId}' is already registered with different content`,
        { policyId: policy.policyId },
      );
    }
    this.policies.set(policy.policyId, {
      ...policy,
      allowedUploadMimeTypes: [...policy.allowedUploadMimeTypes],
    });
  }

  public getPolicy(policyId: string): DataFlowPolicy | null {
    const policy = this.policies.get(policyId);
    return policy === undefined
      ? null
      : { ...policy, allowedUploadMimeTypes: [...policy.allowedUploadMimeTypes] };
  }

  public evaluateClipboardRead(
    taskId: string,
    policyId: string,
    clipboardContent: string,
  ): DataFlowCheckResult {
    return this.evaluateClipboard(taskId, policyId, "clipboard_read", clipboardContent);
  }

  public evaluateClipboardWrite(
    taskId: string,
    policyId: string,
    textToWrite: string,
  ): DataFlowCheckResult {
    return this.evaluateClipboard(taskId, policyId, "clipboard_write", textToWrite);
  }

  public evaluateUpload(
    taskId: string,
    policyId: string,
    fileName: string,
    mimeType: string,
    bytesCount: ByteCount,
    artifact: ContentArtifactIdentity | null = null,
    dlpReceipt: DlpScanReceipt | null = null,
  ): DataFlowCheckResult {
    const policy = this.policies.get(policyId);
    const artifactValid = artifact !== null && this.isArtifactIdentityValid(artifact);
    const dlpReceiptValid = dlpReceipt !== null && this.isDlpReceiptValid(dlpReceipt);
    const admittedArtifact = artifactValid && artifact !== null
      ? {
          artifactId: artifactUriSchema.parse(artifact.artifactId),
          contentHash: contentHashSchema.parse(artifact.contentHash),
        }
      : null;
    const admittedDlpReceipt = dlpReceiptValid && dlpReceipt !== null
      ? {
          receiptArtifactId: artifactUriSchema.parse(dlpReceipt.receiptArtifactId),
          destinationEvidenceArtifactId: dlpReceipt.destinationEvidenceArtifactId === null
            ? null
            : artifactUriSchema.parse(dlpReceipt.destinationEvidenceArtifactId),
        }
      : null;
    const receiptBound = artifactValid
      && dlpReceiptValid
      && artifact !== null
      && dlpReceipt !== null
      && dlpReceipt.destinationEvidenceArtifactId === null
      && this.sameArtifact(artifact, dlpReceipt);
    const auditBase = {
      transferId: generateUuid7(),
      taskId,
      direction: "upload" as const,
      source: fileName,
      destination: "external_target",
      bytesCount,
      mimeType,
      dlpScanPassed: dlpReceipt === null ? null : receiptBound && dlpReceipt.passed,
      quarantinedPath: null,
      artifactId: admittedArtifact?.artifactId ?? null,
      contentHash: admittedArtifact?.contentHash ?? null,
      dlpReceiptArtifactId: admittedDlpReceipt?.receiptArtifactId ?? null,
      destinationEvidenceArtifactId: admittedDlpReceipt?.destinationEvidenceArtifactId ?? null,
      timestamp: nowTimestamp(),
    };
    if (policy === undefined) return this.recordDecision(false, `Policy not found: ${policyId}`, auditBase);
    if (!this.policyApplies(policy, taskId)) {
      return this.recordDecision(false, "Data-flow policy is bound to a different task", auditBase);
    }
    const mimeAllowed = this.mimeAllowed(policy.allowedUploadMimeTypes, mimeType);
    const sizeAllowed = bytesCount <= policy.maxUploadBytes;
    const dlpAllowed = !policy.dlpScanRequired || (receiptBound && dlpReceipt?.passed === true);
    const allowed = mimeAllowed && sizeAllowed && dlpAllowed;
    const reason = !mimeAllowed
      ? `Upload MIME type ${mimeType} is not allowed`
      : !sizeAllowed
        ? `Upload size ${bytesCount.toString()} exceeds ${policy.maxUploadBytes.toString()} bytes`
        : !dlpAllowed
          ? this.uploadDlpFailureReason(artifact, dlpReceipt, receiptBound)
          : "Upload metadata and DLP receipt satisfy policy";
    return this.recordDecision(allowed, reason, auditBase);
  }

  /**
   * Record a quarantine effect only after the kernel or sandbox returns a
   * receipt. This method does not create directories or move files.
   */
  public recordQuarantinedDownload(
    taskId: string,
    policyId: string,
    fileName: string,
    mimeType: string,
    bytesCount: ByteCount,
    expectedSource: ContentArtifactIdentity,
    receipt: DownloadQuarantineReceipt,
  ): DataTransferAudit {
    const policy = this.policies.get(policyId);
    if (policy === undefined) throw new PolicyDeniedError(`Data-flow policy not found: ${policyId}`);
    if (!this.policyApplies(policy, taskId)) {
      throw new PolicyDeniedError("Data-flow policy is bound to a different task", {
        policyTaskId: policy.taskId,
        taskId,
      });
    }
    if (!policy.downloadQuarantine) {
      throw new PolicyDeniedError("Policy does not authorize download quarantine");
    }
    this.requireArtifactIdentity(expectedSource, "Expected download source");
    this.requireArtifactIdentity(receipt.source, "Quarantine receipt source");
    this.requireArtifactIdentity(receipt.destination, "Quarantine receipt destination");
    this.requireDlpReceipt(receipt.dlpScan);
    if (!this.sameArtifact(expectedSource, receipt.source)) {
      throw new PolicyDeniedError("Quarantine receipt is bound to a different source artifact", {
        expectedArtifactId: expectedSource.artifactId,
        receiptArtifactId: receipt.source.artifactId,
      });
    }
    if (receipt.source.contentHash !== receipt.destination.contentHash) {
      throw new PolicyDeniedError("Quarantine destination content hash differs from the source artifact");
    }
    if (!this.sameArtifact(receipt.destination, receipt.dlpScan)) {
      throw new PolicyDeniedError("DLP receipt is not bound to the quarantined destination artifact");
    }
    if (receipt.dlpScan.destinationEvidenceArtifactId !== receipt.destination.evidenceArtifactId) {
      throw new PolicyDeniedError("DLP receipt is not bound to the quarantine destination evidence");
    }
    if (policy.dlpScanRequired && !receipt.dlpScan.passed) {
      throw new PolicyDeniedError("Quarantined download failed the required DLP scan");
    }
    if (receipt.destination.quarantinedPath.trim().length === 0) {
      throw new ValidationError("Quarantine receipt path is required");
    }
    if (!this.isPathWithinDirectory(policy.quarantineDirectory, receipt.destination.quarantinedPath)) {
      throw new PolicyDeniedError("Quarantine receipt escaped the policy directory", {
        quarantineDirectory: policy.quarantineDirectory,
        quarantinedPath: receipt.destination.quarantinedPath,
      });
    }
    const audit: DataTransferAudit = {
      transferId: generateUuid7(),
      taskId,
      direction: "download",
      source: fileName,
      destination: receipt.destination.quarantinedPath,
      bytesCount,
      mimeType,
      dlpScanPassed: receipt.dlpScan.passed,
      quarantinedPath: receipt.destination.quarantinedPath,
      artifactId: artifactUriSchema.parse(receipt.destination.artifactId),
      contentHash: contentHashSchema.parse(receipt.destination.contentHash),
      dlpReceiptArtifactId: artifactUriSchema.parse(receipt.dlpScan.receiptArtifactId),
      destinationEvidenceArtifactId: artifactUriSchema.parse(receipt.destination.evidenceArtifactId),
      timestamp: nowTimestamp(),
    };
    dataTransferAuditSchema.parse(audit);
    this.audits.push(audit);
    return { ...audit };
  }

  public getAudits(taskId?: string): readonly DataTransferAudit[] {
    const audits = taskId === undefined
      ? this.audits
      : this.audits.filter((audit) => audit.taskId === taskId);
    return audits.map((audit) => ({ ...audit }));
  }

  public detectSecrets(text: string): boolean {
    return this.dlpSecretPatterns.some((pattern) => pattern.test(text));
  }

  private evaluateClipboard(
    taskId: string,
    policyId: string,
    direction: "clipboard_read" | "clipboard_write",
    content: string,
  ): DataFlowCheckResult {
    const policy = this.policies.get(policyId);
    const dlpPassed = !this.detectSecrets(content);
    const auditBase = {
      transferId: generateUuid7(),
      taskId,
      direction,
      source: direction === "clipboard_read" ? "system_clipboard" : "agent_context",
      destination: direction === "clipboard_read" ? "agent_context" : "system_clipboard",
      bytesCount: BigInt(new TextEncoder().encode(content).byteLength) as ByteCount,
      mimeType: "text/plain",
      dlpScanPassed: dlpPassed,
      quarantinedPath: null,
      artifactId: null,
      contentHash: null,
      dlpReceiptArtifactId: null,
      destinationEvidenceArtifactId: null,
      timestamp: nowTimestamp(),
    };
    if (policy === undefined) return this.recordDecision(false, `Policy not found: ${policyId}`, auditBase);
    if (!this.policyApplies(policy, taskId)) {
      return this.recordDecision(false, "Data-flow policy is bound to a different task", auditBase);
    }
    const accessAllowed = direction === "clipboard_read"
      ? policy.clipboardAccess === "read_only" || policy.clipboardAccess === "read_write"
      : policy.clipboardAccess === "write_only" || policy.clipboardAccess === "read_write";
    const allowed = accessAllowed && (!policy.dlpScanRequired || dlpPassed);
    const reason = !accessAllowed
      ? `${direction} is denied by clipboard mode ${policy.clipboardAccess}`
      : !dlpPassed && policy.dlpScanRequired
        ? `${direction} was blocked by DLP`
        : `${direction} satisfies policy`;
    return this.recordDecision(allowed, reason, auditBase);
  }

  private recordDecision(
    allowed: boolean,
    reason: string,
    auditInput: DataTransferAudit,
  ): DataFlowCheckResult {
    dataTransferAuditSchema.parse(auditInput);
    const audit = auditInput;
    this.audits.push(audit);
    const result: DataFlowCheckResult = { allowed, reason, audit };
    dataFlowCheckResultSchema.parse(result);
    return result;
  }

  private policyApplies(policy: DataFlowPolicy, taskId: string): boolean {
    return policy.taskId === taskId || policy.taskId === "*";
  }

  private mimeAllowed(allowed: readonly string[], mimeType: string): boolean {
    if (allowed.includes("*/*") || allowed.includes(mimeType)) return true;
    const slash = mimeType.indexOf("/");
    return slash > 0 && allowed.includes(`${mimeType.slice(0, slash)}/*`);
  }

  private uploadDlpFailureReason(
    artifact: ContentArtifactIdentity | null,
    receipt: DlpScanReceipt | null,
    receiptBound: boolean,
  ): string {
    if (artifact === null || !this.isArtifactIdentityValid(artifact)) {
      return "Upload requires an immutable artifact identity and exact content hash";
    }
    if (receipt === null) return "Upload requires a full-content DLP scan receipt";
    if (!receiptBound) return "DLP receipt does not bind the exact upload artifact and content hash";
    return "Upload failed the required full-content DLP scan";
  }

  private isArtifactIdentityValid(identity: ContentArtifactIdentity): boolean {
    return IMMUTABLE_ARTIFACT_PATTERN.test(identity.artifactId)
      && contentHashSchema.safeParse(identity.contentHash).success;
  }

  private isDlpReceiptValid(receipt: DlpScanReceipt): boolean {
    return this.isArtifactIdentityValid(receipt)
      && IMMUTABLE_ARTIFACT_PATTERN.test(receipt.receiptArtifactId)
      && (
        receipt.destinationEvidenceArtifactId === null
        || IMMUTABLE_ARTIFACT_PATTERN.test(receipt.destinationEvidenceArtifactId)
      )
      && receipt.scannerVersion.trim().length > 0;
  }

  private requireArtifactIdentity(identity: ContentArtifactIdentity, label: string): void {
    if (!this.isArtifactIdentityValid(identity)) {
      throw new ValidationError(`${label} requires an immutable artifact reference and content hash`);
    }
  }

  private requireDlpReceipt(receipt: DlpScanReceipt): void {
    if (!this.isDlpReceiptValid(receipt)) {
      throw new ValidationError("DLP receipt requires immutable artifact identities and a scanner version");
    }
  }

  private sameArtifact(left: ContentArtifactIdentity, right: ContentArtifactIdentity): boolean {
    return left.artifactId === right.artifactId && left.contentHash === right.contentHash;
  }

  private samePolicy(left: DataFlowPolicy, right: DataFlowPolicy): boolean {
    return left.policyId === right.policyId
      && left.taskId === right.taskId
      && left.clipboardAccess === right.clipboardAccess
      && left.allowedUploadMimeTypes.length === right.allowedUploadMimeTypes.length
      && left.allowedUploadMimeTypes.every((mimeType, index) => mimeType === right.allowedUploadMimeTypes[index])
      && left.maxUploadBytes === right.maxUploadBytes
      && left.downloadQuarantine === right.downloadQuarantine
      && left.dlpScanRequired === right.dlpScanRequired
      && left.quarantineDirectory === right.quarantineDirectory;
  }

  private isPathWithinDirectory(directory: string, candidate: string): boolean {
    if (directory.includes("\0") || candidate.includes("\0")) return false;
    const normalizedDirectory = directory.endsWith("/")
      ? directory.slice(0, -1)
      : directory;
    const expectedPrefix = `${normalizedDirectory}/`;
    if (!candidate.startsWith(expectedPrefix)) return false;
    const relativeSegments = candidate.slice(expectedPrefix.length).split("/");
    return relativeSegments.length > 0
      && relativeSegments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  }
}
