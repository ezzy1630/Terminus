#!/usr/bin/env bun
/**
 * codegen-v2-schemas — ARP v2 canonical schema registry emission.
 *
 * Per SPEC §45.3 and the Phase 1 roadmap ("implement schema registry and
 * code generation"): every Zod aggregate schema that crosses the ARP v2
 * boundary in `@terminus/domain` is emitted as a static JSON Schema
 * (draft 2020-12) under `schemas/generated/v2/`, plus a registry manifest
 * binding each schema name to its artifact path and content hash.
 *
 * Output is deterministic: no timestamps, fixed schema order, sorted hash
 * entries — so `just codegen-check` can verify zero drift.
 *
 * `bigint` constraint values (e.g. `constraints.costMicros`) have no JSON
 * Schema representation; they are emitted as `{}` (`unrepresentable:
 * "any"`) and flagged in the registry entry notes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  missionSchema,
  taskContractV2Schema,
  taskV2Schema,
  workflowNodeSchema,
  guardedEdgeSchema,
  workflowSchema,
  nodeRunSchema,
  claimSchema,
  evidenceSchema,
  authorizationInstanceSchema,
  effectRecordSchema,
  questionSchema,
  decisionSchema,
  riskSchema,
  workerLeaseSchema,
  taskAttemptSchema,
  outboxMessageSchema,
  inboxMessageSchema,
  budgetConsumptionSchema,
  resourceHandleSchema,
  approvalPresentationSchema,
  sequencePolicyRuleSchema,
  sourceSpanSchema,
  witnessPathSchema,
  staticValidationReportSchema,
  modelProfileSchema,
  routeDecisionV2Schema,
  modelCohortPosteriorSchema,
  delegationContractV2Schema,
  stagnationReportSchema,
  providerContinuationSchema,
  organizationSchema,
  departmentSchema,
  operatorAgentSchema,
  agentRoomSchema,
  capabilityDirectoryEntrySchema,
  materialQuestionSchema,
  attentionAssessmentSchema,
  structuredInterventionSchema,
  causalStepSchema,
  causalReplayTraceSchema,
  counterfactualExperimentSchema,
  mobileSupervisionSessionSchema,
  acpContextInjectionSchema,
  uiViewportSchema,
  uiBoundingBoxSchema,
  uiDomNodeSchema,
  uiAccessibilityNodeSchema,
  uiElementTargetSchema,
  uiObservationInputSchema,
  uiObservationSchema,
  computerUseActionSchema,
  semanticTargetVerificationSchema,
  uiEvidenceRecordSchema,
  browserDesktopPoolSchema,
  poolLeaseSchema,
  humanTakeoverSessionSchema,
  dataFlowPolicySchema,
  dataTransferAuditSchema,
  dataFlowCheckResultSchema,
  externalConnectorSpecSchema,
  connectorCallIntentSchema,
  connectorExecutionObservationSchema,
  connectorCallResultSchema,
  ambiguousSubmitReconciliationSchema,
  incidentProfileSpecSchema,
  incidentExecutionRecordSchema,
  researchProfileSpecSchema,
  researchProvenanceRecordSchema,
} from "../../packages/domain/src/aggregates.ts";

const ROOT = process.env.TERMINUS_ROOT ?? join(import.meta.dir, "..", "..");
const OUT_DIR = join(ROOT, "schemas", "generated", "v2");

interface RegistryEntry {
  readonly name: string;
  readonly title: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** Ordered schema registry: name → (title, zod schema). Order is stable. */
const SCHEMAS: ReadonlyArray<readonly [string, string, z.ZodType]> = [
  ["mission", "Mission", missionSchema],
  ["task-contract-v2", "TaskContractV2", taskContractV2Schema],
  ["task-v2", "TaskV2", taskV2Schema],
  ["workflow-node", "WorkflowNode", workflowNodeSchema],
  ["guarded-edge", "GuardedEdge", guardedEdgeSchema],
  ["workflow", "Workflow", workflowSchema],
  ["node-run", "NodeRun", nodeRunSchema],
  ["source-span", "SourceSpan", sourceSpanSchema],
  ["witness-path", "WitnessPath", witnessPathSchema],
  ["static-validation-report", "StaticValidationReport", staticValidationReportSchema],
  ["claim", "Claim", claimSchema],
  ["evidence", "Evidence", evidenceSchema],
  ["resource-handle", "ResourceHandle", resourceHandleSchema],
  ["authorization-instance", "AuthorizationInstance", authorizationInstanceSchema],
  ["approval-presentation", "ApprovalPresentation", approvalPresentationSchema],
  ["sequence-policy-rule", "SequencePolicyRule", sequencePolicyRuleSchema],
  ["effect-record", "EffectRecord", effectRecordSchema],
  ["question", "Question", questionSchema],
  ["decision", "Decision", decisionSchema],
  ["risk", "Risk", riskSchema],
  ["worker-lease", "WorkerLease", workerLeaseSchema],
  ["task-attempt", "TaskAttempt", taskAttemptSchema],
  ["outbox-message", "OutboxMessage", outboxMessageSchema],
  ["inbox-message", "InboxMessage", inboxMessageSchema],
  ["budget-consumption", "BudgetConsumption", budgetConsumptionSchema],
  ["model-profile", "ModelProfile", modelProfileSchema],
  ["route-decision-v2", "RouteDecisionV2", routeDecisionV2Schema],
  ["model-cohort-posterior", "ModelCohortPosterior", modelCohortPosteriorSchema],
  ["delegation-contract-v2", "DelegationContractV2", delegationContractV2Schema],
  ["stagnation-report", "StagnationReport", stagnationReportSchema],
  ["provider-continuation", "ProviderContinuation", providerContinuationSchema],
  ["organization", "Organization", organizationSchema],
  ["department", "Department", departmentSchema],
  ["operator-agent", "OperatorAgent", operatorAgentSchema],
  ["agent-room", "AgentRoom", agentRoomSchema],
  ["capability-directory-entry", "CapabilityDirectoryEntry", capabilityDirectoryEntrySchema],
  ["material-question", "MaterialQuestion", materialQuestionSchema],
  ["attention-assessment", "AttentionAssessment", attentionAssessmentSchema],
  ["structured-intervention", "StructuredIntervention", structuredInterventionSchema],
  ["causal-step", "CausalStep", causalStepSchema],
  ["causal-replay-trace", "CausalReplayTrace", causalReplayTraceSchema],
  ["counterfactual-experiment", "CounterfactualExperiment", counterfactualExperimentSchema],
  ["mobile-supervision-session", "MobileSupervisionSession", mobileSupervisionSessionSchema],
  ["acp-context-injection", "AcpContextInjection", acpContextInjectionSchema],
  ["ui-viewport", "UiViewport", uiViewportSchema],
  ["ui-bounding-box", "UiBoundingBox", uiBoundingBoxSchema],
  ["ui-dom-node", "UiDomNode", uiDomNodeSchema],
  ["ui-accessibility-node", "UiAccessibilityNode", uiAccessibilityNodeSchema],
  ["ui-element-target", "UiElementTarget", uiElementTargetSchema],
  ["ui-observation-input", "UiObservationInput", uiObservationInputSchema],
  ["ui-observation", "UiObservation", uiObservationSchema],
  ["computer-use-action", "ComputerUseAction", computerUseActionSchema],
  ["semantic-target-verification", "SemanticTargetVerification", semanticTargetVerificationSchema],
  ["ui-evidence-record", "UiEvidenceRecord", uiEvidenceRecordSchema],
  ["browser-desktop-pool", "BrowserDesktopPool", browserDesktopPoolSchema],
  ["pool-lease", "PoolLease", poolLeaseSchema],
  ["human-takeover-session", "HumanTakeoverSession", humanTakeoverSessionSchema],
  ["data-flow-policy", "DataFlowPolicy", dataFlowPolicySchema],
  ["data-transfer-audit", "DataTransferAudit", dataTransferAuditSchema],
  ["data-flow-check-result", "DataFlowCheckResult", dataFlowCheckResultSchema],
  ["external-connector-spec", "ExternalConnectorSpec", externalConnectorSpecSchema],
  ["connector-call-intent", "ConnectorCallIntent", connectorCallIntentSchema],
  ["connector-execution-observation", "ConnectorExecutionObservation", connectorExecutionObservationSchema],
  ["connector-call-result", "ConnectorCallResult", connectorCallResultSchema],
  ["ambiguous-submit-reconciliation", "AmbiguousSubmitReconciliation", ambiguousSubmitReconciliationSchema],
  ["incident-profile-spec", "IncidentProfileSpec", incidentProfileSpecSchema],
  ["incident-execution-record", "IncidentExecutionRecord", incidentExecutionRecordSchema],
  ["research-profile-spec", "ResearchProfileSpec", researchProfileSpecSchema],
  ["research-provenance-record", "ResearchProvenanceRecord", researchProvenanceRecordSchema],
];

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const entries: RegistryEntry[] = [];

  for (const [name, title, schema] of SCHEMAS) {
    // `io: "input"` describes what clients may SEND; `unrepresentable:
    // "any"` downgrades bigint constraints to permissive `{}` so the
    // registry stays valid draft 2020-12.
    const jsonSchema = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
    const doc = {
      $id: `https://terminus.dev/schemas/v2/${name}.json`,
      title,
      ...jsonSchema,
    };
    const body = JSON.stringify(doc, null, 2) + "\n";
    const file = join(OUT_DIR, `${name}.json`);
    writeFileSync(file, body, "utf8");
    entries.push({
      name,
      title,
      path: `schemas/generated/v2/${name}.json`,
      sha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      bytes: Buffer.byteLength(body),
    });
  }

  const registry = {
    protocolVersion: 2,
    draft: "https://json-schema.org/draft/2020-12/schema",
    sourceOfTruth: "packages/domain/src/aggregates.ts (zod)",
    generator: "tools/codegen/v2-schemas.ts",
    notes: [
      "bigint constraint values are emitted as {} (JSON Schema has no bigint type); canonical Micros, token counts, and byte counts are serialized as decimal strings on the wire.",
    ],
    schemas: entries,
  };
  const registryPath = join(OUT_DIR, "registry.json");
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n", "utf8");

  console.log(`[codegen-v2-schemas] wrote ${entries.length} schemas + registry under schemas/generated/v2/`);
}

main();
