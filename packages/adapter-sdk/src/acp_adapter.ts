/**
 * @terminus/adapter-sdk — Agent Client Protocol (ACP) Boundary Adapter.
 *
 * Per SPEC §9.3:
 * Translates editor/client protocol messages (document synchronization,
 * selection changes, diagnostics, and file edits) into canonical ARP v2
 * task context, resource handles, and effect records.
 */
import type { ResourceHandle } from "@terminus/domain";

export interface AcpTextDocument {
  readonly uri: string;
  readonly languageId: string;
  readonly version: number;
  readonly text: string;
}

export interface AcpDiagnostic {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly severity: "error" | "warning" | "information" | "hint";
  readonly source: string;
  readonly message: string;
}

export interface AcpSelection {
  readonly uri: string;
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
  readonly selectedText: string;
}

export class AcpBoundaryAdapter {
  /**
   * Translates an open document into a scoped canonical ResourceHandle.
   */
  static documentToResourceHandle(
    doc: AcpTextDocument,
    taskId: string,
    principal: string,
  ): ResourceHandle {
    return {
      objectId: `doc:${doc.uri}`,
      objectType: "acp_document",
      version: doc.version,
      scope: [doc.uri],
      allowedOperations: ["read", "edit"],
      principalBinding: principal,
      taskBinding: taskId,
      authorityEpoch: 1,
      provenance: "acp_editor_sync",
      trustLabel: "USER_TRUSTED",
      expiry: null,
      integrityHash: `sha256:acp_${doc.uri}_${doc.version}`,
    };
  }

  /**
   * Translates an editor selection into a scoped canonical ResourceHandle.
   */
  static selectionToResourceHandle(
    selection: AcpSelection,
    taskId: string,
    principal: string,
  ): ResourceHandle {
    return {
      objectId: `selection:${selection.uri}:${selection.start.line}:${selection.end.line}`,
      objectType: "acp_selection",
      version: 1,
      scope: [selection.uri],
      allowedOperations: ["read"],
      principalBinding: principal,
      taskBinding: taskId,
      authorityEpoch: 1,
      provenance: "acp_editor_selection",
      trustLabel: "USER_TRUSTED",
      expiry: null,
      integrityHash: `sha256:selection_${selection.selectedText.length}`,
    };
  }

  /**
   * Formats diagnostics into canonical diagnostic objects.
   */
  static diagnosticsToCanonical(diagnostics: readonly AcpDiagnostic[], uri: string) {
    return diagnostics.map((d) => ({
      path: uri,
      startLine: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLine: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      severity: d.severity,
      source: d.source,
      message: d.message,
    }));
  }
}
