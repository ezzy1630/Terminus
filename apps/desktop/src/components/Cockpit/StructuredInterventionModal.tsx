import { X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useDialogFocus } from "../../hooks/use-dialog-focus";
import { isDefinitiveMutationFailure, useLogicalMutation } from "../../hooks/use-logical-mutation";
import { arpV2 } from "../../lib/api-v2";
import type {
  StructuredInterventionSnapshot,
  StructuredInterventionVerb,
} from "../../types/v2";
import { SemanticBadge, TaskRequiredState } from "./CockpitPrimitives";
import { Select } from "../../ui/Select";
import { Button } from "../../ui/Button";
import { DialogSurface } from "../../ui/Dialog";
import { IconButton } from "../../ui/IconButton";

type TargetMode = "none" | "task" | "required";
type ConfirmationMode = "none" | "checkbox" | "type_target";
type FormStage = "edit" | "review" | "proposed";

interface VerbDefinition {
  verb: StructuredInterventionVerb;
  label: string;
  description: string;
  targetMode: TargetMode;
  targetLabel?: string;
  confirmation: ConfirmationMode;
}

const VERBS: VerbDefinition[] = [
  { verb: "focus", label: "Focus", description: "Narrow attention to one file, subsystem, or workflow node.", targetMode: "required", targetLabel: "Focus target", confirmation: "none" },
  { verb: "ignore", label: "Ignore", description: "Ignore one non-blocking diagnostic or path.", targetMode: "required", targetLabel: "Diagnostic or path", confirmation: "none" },
  { verb: "elaborate", label: "Elaborate", description: "Add operator-authored context to the task.", targetMode: "task", confirmation: "none" },
  { verb: "change_constraint", label: "Change constraint", description: "Change a cost, timeout, or security constraint.", targetMode: "task", confirmation: "checkbox" },
  { verb: "edit_plan", label: "Edit plan", description: "Request a typed workflow graph edit.", targetMode: "required", targetLabel: "Workflow or node ID", confirmation: "checkbox" },
  { verb: "approve_exact_effect", label: "Approve exact effect", description: "Authorize one exact effect ID.", targetMode: "required", targetLabel: "Effect ID", confirmation: "type_target" },
  { verb: "deny_narrow", label: "Deny and narrow", description: "Deny one effect and restrict named capabilities.", targetMode: "required", targetLabel: "Effect ID", confirmation: "type_target" },
  { verb: "pause", label: "Pause", description: "Pause the selected task.", targetMode: "task", confirmation: "checkbox" },
  { verb: "resume", label: "Resume", description: "Resume the selected task.", targetMode: "task", confirmation: "checkbox" },
  { verb: "takeover", label: "Human takeover", description: "Transfer task control to the named human principal.", targetMode: "task", confirmation: "type_target" },
  { verb: "fork", label: "Fork attempt", description: "Create a labeled independent attempt from the selected task state.", targetMode: "task", confirmation: "checkbox" },
  { verb: "rewind", label: "Rewind", description: "Roll workspace mutations back to an exact checkpoint.", targetMode: "required", targetLabel: "Checkpoint hash", confirmation: "type_target" },
  { verb: "terminate", label: "Terminate", description: "Cancel the selected task with a recorded rationale.", targetMode: "task", confirmation: "type_target" },
  { verb: "request_independent_review", label: "Request independent review", description: "Start a detached clean-context review.", targetMode: "task", confirmation: "none" },
];

interface InterventionDraft {
  taskId: string;
  verb: StructuredInterventionVerb;
  targetEntityId: string | null;
  payload: Record<string, unknown>;
  rationale: string;
}

interface InterventionFormValues {
  verb: StructuredInterventionVerb;
  targetInput: string;
  rationale: string;
  contextText: string;
  constraintName: string;
  constraintValue: string;
  planOperation: string;
  planInstruction: string;
  restrictedCapabilities: string;
  takeoverPrincipal: string;
  forkLabel: string;
  reviewScope: string;
}

const INTERVENTION_DRAFT_PREFIX = "terminus-desktop.intervention-draft.v1.";
const MAX_INTERVENTION_DRAFT_BYTES = 32 * 1024;
const MAX_INTERVENTION_FIELD_BYTES = 8 * 1024;
const INTERVENTION_DRAFT_WRITE_DELAY_MS = 150;
const interventionDraftEncoder = new TextEncoder();
const DEFAULT_FORM_VALUES: InterventionFormValues = {
  verb: "focus",
  targetInput: "",
  rationale: "",
  contextText: "",
  constraintName: "timeout_seconds",
  constraintValue: "",
  planOperation: "replace_node",
  planInstruction: "",
  restrictedCapabilities: "",
  takeoverPrincipal: "",
  forkLabel: "",
  reviewScope: "full_task",
};

function interventionDraftStorageKey(taskId: string): string {
  return `${INTERVENTION_DRAFT_PREFIX}${taskId}`;
}

function validateInterventionFormValues(values: InterventionFormValues): string | null {
  for (const [field, value] of Object.entries(values)) {
    if (interventionDraftEncoder.encode(value).byteLength > MAX_INTERVENTION_FIELD_BYTES) {
      return `${field} exceeds the 8 KiB intervention-draft field limit.`;
    }
  }
  if (interventionDraftEncoder.encode(JSON.stringify(values)).byteLength > MAX_INTERVENTION_DRAFT_BYTES) {
    return "The intervention draft exceeds the 32 KiB storage limit.";
  }
  return null;
}

function readInterventionFormValues(taskId: string | null | undefined): {
  values: InterventionFormValues;
  error: string | null;
} {
  if (!taskId) return { values: DEFAULT_FORM_VALUES, error: null };
  try {
    const storage = window.localStorage;
    if (!storage) throw new Error("Local storage is unavailable.");
    const raw = storage.getItem(interventionDraftStorageKey(taskId));
    if (raw === null) return { values: DEFAULT_FORM_VALUES, error: null };
    if (interventionDraftEncoder.encode(raw).byteLength > MAX_INTERVENTION_DRAFT_BYTES) {
      return { values: DEFAULT_FORM_VALUES, error: "Stored intervention data exceeds the supported limit and was preserved for recovery." };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { values: DEFAULT_FORM_VALUES, error: "Stored intervention data is invalid and was preserved for recovery." };
    }
    const record = parsed as Record<string, unknown>;
    const stringValue = (field: keyof InterventionFormValues): string =>
      typeof record[field] === "string" ? record[field] : DEFAULT_FORM_VALUES[field];
    const storedVerb = record.verb;
    const values = {
      verb: typeof storedVerb === "string" && VERBS.some((entry) => entry.verb === storedVerb)
        ? storedVerb as StructuredInterventionVerb
        : DEFAULT_FORM_VALUES.verb,
      targetInput: stringValue("targetInput"),
      rationale: stringValue("rationale"),
      contextText: stringValue("contextText"),
      constraintName: stringValue("constraintName"),
      constraintValue: stringValue("constraintValue"),
      planOperation: stringValue("planOperation"),
      planInstruction: stringValue("planInstruction"),
      restrictedCapabilities: stringValue("restrictedCapabilities"),
      takeoverPrincipal: stringValue("takeoverPrincipal"),
      forkLabel: stringValue("forkLabel"),
      reviewScope: stringValue("reviewScope"),
    };
    const validationError = validateInterventionFormValues(values);
    return validationError
      ? { values: DEFAULT_FORM_VALUES, error: `${validationError} The original entry was preserved for recovery.` }
      : { values, error: null };
  } catch (error) {
    return {
      values: DEFAULT_FORM_VALUES,
      error: error instanceof Error
        ? `Stored intervention data could not be read: ${error.message}`
        : "Stored intervention data could not be read.",
    };
  }
}

function writeInterventionFormValues(taskId: string, values: InterventionFormValues | null): string | null {
  if (values) {
    const validationError = validateInterventionFormValues(values);
    if (validationError) return `${validationError} The current form remains available only in this window.`;
  }
  try {
    const storage = window.localStorage;
    if (!storage) throw new Error("Local storage is unavailable.");
    if (values) storage.setItem(interventionDraftStorageKey(taskId), JSON.stringify(values));
    else storage.removeItem(interventionDraftStorageKey(taskId));
    return null;
  } catch (error) {
    return error instanceof Error
      ? `Intervention form remains available only in this window: ${error.message}`
      : "Intervention form remains available only in this window because local storage failed.";
  }
}

function payloadForVerb({
  verb,
  target,
  contextText,
  constraintName,
  constraintValue,
  planOperation,
  planInstruction,
  restrictedCapabilities,
  takeoverPrincipal,
  forkLabel,
  reviewScope,
}: {
  verb: StructuredInterventionVerb;
  target: string | null;
  contextText: string;
  constraintName: string;
  constraintValue: string;
  planOperation: string;
  planInstruction: string;
  restrictedCapabilities: string;
  takeoverPrincipal: string;
  forkLabel: string;
  reviewScope: string;
}): Record<string, unknown> {
  switch (verb) {
    case "focus": return { scope: target ? [target] : [] };
    case "elaborate": return { text: contextText.trim() };
    case "change_constraint": return { constraint: constraintName, value: constraintValue.trim() };
    case "edit_plan": return { operation: planOperation, instruction: planInstruction.trim() };
    case "approve_exact_effect": return { effectId: target };
    case "deny_narrow": return {
      effectId: target,
      restrictedCapabilities: restrictedCapabilities.split(",").map((item) => item.trim()).filter(Boolean),
    };
    case "fork": return { label: forkLabel.trim() };
    case "rewind": return { checkpointHash: target };
    case "takeover": return { humanPrincipal: takeoverPrincipal.trim() };
    case "request_independent_review": return { scope: reviewScope.trim() };
    case "ignore":
    case "pause":
    case "resume":
    case "terminate":
      return {};
  }
}

function interventionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function StructuredInterventionModal({
  isOpen,
  onClose,
  selectedTaskId,
}: {
  isOpen: boolean;
  onClose: () => void;
  selectedTaskId?: string | null;
}): JSX.Element | null {
  const [savedFormLoad] = useState(() => readInterventionFormValues(selectedTaskId));
  const savedFormValues = savedFormLoad.values;
  const [verb, setVerb] = useState<StructuredInterventionVerb>(savedFormValues.verb);
  const [targetInput, setTargetInput] = useState(savedFormValues.targetInput);
  const [rationale, setRationale] = useState(savedFormValues.rationale);
  const [contextText, setContextText] = useState(savedFormValues.contextText);
  const [constraintName, setConstraintName] = useState(savedFormValues.constraintName);
  const [constraintValue, setConstraintValue] = useState(savedFormValues.constraintValue);
  const [planOperation, setPlanOperation] = useState(savedFormValues.planOperation);
  const [planInstruction, setPlanInstruction] = useState(savedFormValues.planInstruction);
  const [restrictedCapabilities, setRestrictedCapabilities] = useState(savedFormValues.restrictedCapabilities);
  const [takeoverPrincipal, setTakeoverPrincipal] = useState(savedFormValues.takeoverPrincipal);
  const [forkLabel, setForkLabel] = useState(savedFormValues.forkLabel);
  const [reviewScope, setReviewScope] = useState(savedFormValues.reviewScope);
  const [stage, setStage] = useState<FormStage>("edit");
  const [confirmed, setConfirmed] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const [proposal, setProposal] = useState<StructuredInterventionSnapshot | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftStorageError, setDraftStorageError] = useState<string | null>(savedFormLoad.error);
  const [hydratedTaskId, setHydratedTaskId] = useState<string | null>(selectedTaskId ?? null);
  const blockedDraftTaskIdsRef = useRef(new Set(savedFormLoad.error && selectedTaskId ? [selectedTaskId] : []));
  const clearedDraftTaskIdsRef = useRef(new Set<string>());
  const draftWriteTimerRef = useRef<number | null>(null);
  const editFocusRef = useRef<HTMLButtonElement>(null);
  const reviewFocusRef = useRef<HTMLHeadingElement>(null);
  const proposedFocusRef = useRef<HTMLButtonElement>(null);
  const proposalMutation = useLogicalMutation(`intervention-proposal.${selectedTaskId ?? "no-task"}`);

  const currentFormValues = useMemo<InterventionFormValues>(() => ({
    verb,
    targetInput,
    rationale,
    contextText,
    constraintName,
    constraintValue,
    planOperation,
    planInstruction,
    restrictedCapabilities,
    takeoverPrincipal,
    forkLabel,
    reviewScope,
  }), [
    constraintName,
    constraintValue,
    contextText,
    forkLabel,
    planInstruction,
    planOperation,
    rationale,
    restrictedCapabilities,
    reviewScope,
    takeoverPrincipal,
    targetInput,
    verb,
  ]);
  const latestDraftRef = useRef<{ taskId: string | null; values: InterventionFormValues }>({
    taskId: hydratedTaskId,
    values: currentFormValues,
  });
  latestDraftRef.current = { taskId: hydratedTaskId, values: currentFormValues };

  useEffect(() => {
    const nextTaskId = selectedTaskId ?? null;
    if (hydratedTaskId === nextTaskId) return;
    if (draftWriteTimerRef.current !== null) {
      window.clearTimeout(draftWriteTimerRef.current);
      draftWriteTimerRef.current = null;
    }
    const previous = latestDraftRef.current;
    if (previous.taskId
      && !blockedDraftTaskIdsRef.current.has(previous.taskId)
      && !clearedDraftTaskIdsRef.current.has(previous.taskId)) {
      writeInterventionFormValues(previous.taskId, previous.values);
    }
    const loaded = readInterventionFormValues(nextTaskId);
    setVerb(loaded.values.verb);
    setTargetInput(loaded.values.targetInput);
    setRationale(loaded.values.rationale);
    setContextText(loaded.values.contextText);
    setConstraintName(loaded.values.constraintName);
    setConstraintValue(loaded.values.constraintValue);
    setPlanOperation(loaded.values.planOperation);
    setPlanInstruction(loaded.values.planInstruction);
    setRestrictedCapabilities(loaded.values.restrictedCapabilities);
    setTakeoverPrincipal(loaded.values.takeoverPrincipal);
    setForkLabel(loaded.values.forkLabel);
    setReviewScope(loaded.values.reviewScope);
    setDraftStorageError(loaded.error);
    if (loaded.error && nextTaskId) blockedDraftTaskIdsRef.current.add(nextTaskId);
    setHydratedTaskId(nextTaskId);
    setStage("edit");
    setConfirmed(false);
    setTypedConfirmation("");
    setProposal(null);
    setError(null);
  }, [hydratedTaskId, selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId
      || hydratedTaskId !== selectedTaskId
      || blockedDraftTaskIdsRef.current.has(selectedTaskId)
      || clearedDraftTaskIdsRef.current.has(selectedTaskId)) return;
    if (draftWriteTimerRef.current !== null) window.clearTimeout(draftWriteTimerRef.current);
    const nextValues = currentFormValues;
    draftWriteTimerRef.current = window.setTimeout(() => {
      draftWriteTimerRef.current = null;
      setDraftStorageError(writeInterventionFormValues(selectedTaskId, nextValues));
    }, INTERVENTION_DRAFT_WRITE_DELAY_MS);
    return () => {
      if (draftWriteTimerRef.current !== null) {
        window.clearTimeout(draftWriteTimerRef.current);
        draftWriteTimerRef.current = null;
      }
    };
  }, [currentFormValues, hydratedTaskId, selectedTaskId]);

  useEffect(() => () => {
    if (draftWriteTimerRef.current !== null) window.clearTimeout(draftWriteTimerRef.current);
    const latest = latestDraftRef.current;
    if (latest.taskId
      && !blockedDraftTaskIdsRef.current.has(latest.taskId)
      && !clearedDraftTaskIdsRef.current.has(latest.taskId)) {
      writeInterventionFormValues(latest.taskId, latest.values);
    }
  }, []);

  const closeModal = useCallback((): void => {
    if (submitting) return;
    setStage("edit");
    setConfirmed(false);
    setTypedConfirmation("");
    setProposal(null);
    setError(null);
    onClose();
  }, [onClose, submitting]);
  const dialogRef = useDialogFocus<HTMLDivElement>(isOpen, closeModal);

  useLayoutEffect(() => {
    if (!isOpen) return;
    if (stage === "review") reviewFocusRef.current?.focus();
    else if (stage === "proposed") proposedFocusRef.current?.focus();
    else editFocusRef.current?.focus();
  }, [isOpen, stage]);

  const definition = VERBS.find((entry) => entry.verb === verb) ?? VERBS[0]!;
  const target = definition.targetMode === "task"
    ? selectedTaskId ?? null
    : definition.targetMode === "required"
      ? targetInput.trim() || null
      : null;
  const payload = useMemo(() => payloadForVerb({
    verb,
    target,
    contextText,
    constraintName,
    constraintValue,
    planOperation,
    planInstruction,
    restrictedCapabilities,
    takeoverPrincipal,
    forkLabel,
    reviewScope,
  }), [
    constraintName,
    constraintValue,
    contextText,
    forkLabel,
    planInstruction,
    planOperation,
    restrictedCapabilities,
    reviewScope,
    takeoverPrincipal,
    target,
    verb,
  ]);

  const validationError = !selectedTaskId
    ? "Choose a durable task before proposing an intervention."
    : definition.targetMode === "required" && !target
        ? `${definition.targetLabel ?? "Target"} is required.`
        : !rationale.trim()
          ? "Rationale is required."
          : verb === "elaborate" && !contextText.trim()
            ? "Additional context is required."
            : verb === "change_constraint" && !constraintValue.trim()
              ? "Constraint value is required."
              : verb === "change_constraint" && constraintName === "cost_micros" && !/^(0|[1-9][0-9]*)$/.test(constraintValue.trim())
                ? "Cost must be a canonical non-negative integer in micros."
                : verb === "change_constraint" && constraintName === "timeout_seconds" && !/^[1-9][0-9]*$/.test(constraintValue.trim())
                  ? "Timeout must be a positive whole number of seconds."
              : verb === "edit_plan" && !planInstruction.trim()
                ? "Plan edit instructions are required."
                : verb === "deny_narrow" && !restrictedCapabilities.split(",").some((item) => item.trim())
                  ? "At least one restricted capability is required."
                  : verb === "takeover" && !takeoverPrincipal.trim()
                    ? "Human principal is required."
                    : verb === "fork" && !forkLabel.trim()
                      ? "Fork label is required."
                      : verb === "rewind" && !/^sha256:[0-9a-f]{64}$/.test(target ?? "")
                        ? "Checkpoint must be an exact sha256 content hash."
                      : verb === "request_independent_review" && !reviewScope.trim()
                        ? "Review scope is required."
                        : null;

  const confirmationTarget = verb === "takeover" ? takeoverPrincipal.trim() || null : target;
  const confirmationSatisfied = definition.confirmation === "none"
    || (definition.confirmation === "checkbox" && confirmed)
    || (definition.confirmation === "type_target" && confirmationTarget !== null && typedConfirmation === confirmationTarget);

  const draft: InterventionDraft | null = selectedTaskId && !validationError
      ? {
        taskId: selectedTaskId,
        verb,
        targetEntityId: target,
        payload,
        rationale: rationale.trim(),
      }
    : null;

  if (!isOpen) return null;

  const changeVerb = (nextVerb: StructuredInterventionVerb): void => {
    setVerb(nextVerb);
    setStage("edit");
    setConfirmed(false);
    setTypedConfirmation("");
    setProposal(null);
    setError(null);
  };

  const createProposal = async (): Promise<void> => {
    if (!draft || !confirmationSatisfied) return;
    setSubmitting(true);
    setError(null);
    let operationKey: string | null = null;
    try {
      operationKey = proposalMutation.keyFor(JSON.stringify(draft));
      const created = await arpV2.proposeIntervention(draft, { idempotencyKey: operationKey });
      proposalMutation.settle(operationKey);
      if (draftWriteTimerRef.current !== null) {
        window.clearTimeout(draftWriteTimerRef.current);
        draftWriteTimerRef.current = null;
      }
      const clearError = writeInterventionFormValues(draft.taskId, null);
      setDraftStorageError(clearError);
      if (!clearError) {
        blockedDraftTaskIdsRef.current.delete(draft.taskId);
        clearedDraftTaskIdsRef.current.add(draft.taskId);
      }
      setProposal(created);
      setStage("proposed");
    } catch (reason: unknown) {
      if (operationKey && isDefinitiveMutationFailure(reason)) proposalMutation.abandon(operationKey);
      setError(interventionErrorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const onReview = (event: FormEvent): void => {
    event.preventDefault();
    if (validationError) return;
    setConfirmed(false);
    setTypedConfirmation("");
    setError(null);
    setStage("review");
  };

  return (
    <DialogSurface
      ref={dialogRef}
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) closeModal();
      }}
      onPointerDownOutside={(event) => {
        if (submitting) event.preventDefault();
      }}
      accessibleTitle="Structured intervention"
      aria-describedby="intervention-description"
      tabIndex={-1}
      className="dialog-panel fixed left-1/2 top-1/2 flex max-h-[calc(100%-32px)] w-[min(672px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-strong bg-elevated text-primary shadow-lg"
    >
        <header className="flex flex-shrink-0 items-start justify-between gap-4 border-b border-subtle px-5 py-4">
          <div>
            <h2 id="intervention-title" className="text-base font-semibold">Structured intervention</h2>
            <p id="intervention-description" className="mt-1 text-xs text-secondary">
              Review and record a durable proposal. Application remains unavailable until a kernel-backed intervention executor is configured.
            </p>
          </div>
          <IconButton label="Close structured intervention" icon={<X size={15} aria-hidden />} size="lg" onClick={closeModal} disabled={submitting} data-tooltip={submitting ? "Wait for the current request to finish" : "Close"} className="rounded-md text-tertiary hover:bg-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-45" />
        </header>

        {draftStorageError ? (
          <p className="border-b border-subtle px-5 py-2 text-xs text-tertiary" role="status">
            {draftStorageError}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!selectedTaskId ? (
            <TaskRequiredState feature="Structured interventions" />
          ) : stage === "edit" ? (
            <form onSubmit={onReview} className="space-y-4">
              <div>
                <label htmlFor="intervention-verb" className="block text-xs font-medium text-secondary">Verb</label>
                <Select
                  triggerRef={editFocusRef}
                  id="intervention-verb"
                  label="Verb"
                  value={verb}
                  onValueChange={(value) => changeVerb(value as StructuredInterventionVerb)}
                  className="mt-1 w-full"
                  options={VERBS.map((entry) => ({ value: entry.verb, label: entry.label }))}
                />
                <p className="mt-1 text-xs text-tertiary">{definition.description}</p>
              </div>

              {definition.targetMode === "task" ? (
                <div>
                  <span className="block text-xs font-medium text-secondary">Target task</span>
                  <code className="mt-1 block rounded-md border border-subtle bg-card px-3 py-2 text-xs text-primary">{selectedTaskId}</code>
                </div>
              ) : definition.targetMode === "required" ? (
                <div>
                  <label htmlFor="intervention-target" className="block text-xs font-medium text-secondary">{definition.targetLabel}</label>
                  <input id="intervention-target" maxLength={2048} value={targetInput} onChange={(event) => setTargetInput(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-default bg-canvas px-3 font-mono text-sm text-primary" />
                </div>
              ) : null}

              {verb === "elaborate" ? (
                <div><label htmlFor="intervention-context" className="block text-xs font-medium text-secondary">Additional context</label><textarea id="intervention-context" maxLength={8192} rows={4} value={contextText} onChange={(event) => setContextText(event.target.value)} className="mt-1 w-full rounded-md border border-default bg-canvas px-3 py-2 text-sm text-primary" /></div>
              ) : verb === "change_constraint" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div><label htmlFor="constraint-name" className="block text-xs font-medium text-secondary">Constraint</label><Select id="constraint-name" label="Constraint" value={constraintName} onValueChange={setConstraintName} className="mt-1 w-full" options={[{ value: "cost_micros", label: "Cost cap" }, { value: "timeout_seconds", label: "Timeout" }, { value: "security_policy", label: "Security policy" }]} /></div>
                  <div><label htmlFor="constraint-value" className="block text-xs font-medium text-secondary">New value</label><input id="constraint-value" maxLength={2048} value={constraintValue} onChange={(event) => setConstraintValue(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-default bg-canvas px-3 font-mono text-sm text-primary" /></div>
                </div>
              ) : verb === "edit_plan" ? (
                <div className="space-y-3">
                  <div><label htmlFor="plan-operation" className="block text-xs font-medium text-secondary">Plan operation</label><Select id="plan-operation" label="Plan operation" value={planOperation} onValueChange={setPlanOperation} className="mt-1 w-full" options={[{ value: "replace_node", label: "Replace node" }, { value: "add_node", label: "Add node" }, { value: "remove_node", label: "Remove node" }, { value: "change_edge", label: "Change edge" }]} /></div>
                  <div><label htmlFor="plan-instruction" className="block text-xs font-medium text-secondary">Edit instruction</label><textarea id="plan-instruction" maxLength={8192} rows={3} value={planInstruction} onChange={(event) => setPlanInstruction(event.target.value)} className="mt-1 w-full rounded-md border border-default bg-canvas px-3 py-2 text-sm text-primary" /></div>
                </div>
              ) : verb === "deny_narrow" ? (
                <div><label htmlFor="restricted-capabilities" className="block text-xs font-medium text-secondary">Restricted capabilities</label><input id="restricted-capabilities" maxLength={2048} value={restrictedCapabilities} onChange={(event) => setRestrictedCapabilities(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-default bg-canvas px-3 font-mono text-sm text-primary" placeholder="FS_WRITE, NETWORK_EGRESS" /><p className="mt-1 text-xs text-tertiary">Comma-separated canonical capability IDs.</p></div>
              ) : verb === "takeover" ? (
                <div><label htmlFor="takeover-principal" className="block text-xs font-medium text-secondary">Human principal receiving control</label><input id="takeover-principal" maxLength={2048} value={takeoverPrincipal} onChange={(event) => setTakeoverPrincipal(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-default bg-canvas px-3 font-mono text-sm text-primary" placeholder="human:operator-id" /></div>
              ) : verb === "fork" ? (
                <div><label htmlFor="fork-label" className="block text-xs font-medium text-secondary">Fork label</label><input id="fork-label" maxLength={2048} value={forkLabel} onChange={(event) => setForkLabel(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-default bg-canvas px-3 text-sm text-primary" /></div>
              ) : verb === "request_independent_review" ? (
                <div><label htmlFor="review-scope" className="block text-xs font-medium text-secondary">Review scope</label><input id="review-scope" maxLength={2048} value={reviewScope} onChange={(event) => setReviewScope(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-default bg-canvas px-3 text-sm text-primary" /></div>
              ) : null}

              <div>
                <label htmlFor="intervention-rationale" className="block text-xs font-medium text-secondary">Rationale</label>
                <textarea id="intervention-rationale" maxLength={8192} rows={3} value={rationale} onChange={(event) => setRationale(event.target.value)} className="mt-1 w-full rounded-md border border-default bg-canvas px-3 py-2 text-sm text-primary" />
              </div>

              {validationError ? <p className="text-xs text-tertiary">{validationError}</p> : null}
              <div className="flex justify-end gap-2 border-t border-subtle pt-4">
                <Button type="button" onClick={closeModal} className="h-9 rounded-md px-3 text-sm text-secondary hover:bg-hover">Cancel</Button>
                <Button type="submit" disabled={Boolean(validationError)} className="h-9 rounded-md border border-default bg-selected px-3 text-sm font-medium text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45">Review proposal</Button>
              </div>
            </form>
          ) : stage === "review" && draft ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-subtle bg-card p-4">
                <div className="flex items-center justify-between gap-3"><h3 ref={reviewFocusRef} tabIndex={-1} className="text-sm font-semibold">Review proposal</h3><SemanticBadge tone={definition.confirmation === "none" ? "neutral" : "warning"}>{definition.label}</SemanticBadge></div>
                <dl className="mt-4 grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
                  <div><dt className="text-tertiary">Task</dt><dd className="mt-1 break-all font-mono text-primary">{draft.taskId}</dd></div>
                  <div><dt className="text-tertiary">Target</dt><dd className="mt-1 break-all font-mono text-primary">{draft.targetEntityId ?? "No entity target"}</dd></div>
                  <div><dt className="text-tertiary">Actor</dt><dd className="mt-1 text-primary">Authenticated control-plane operator</dd></div>
                  <div><dt className="text-tertiary">Rationale</dt><dd className="mt-1 text-primary">{draft.rationale}</dd></div>
                </dl>
                {Object.keys(draft.payload).length > 0 ? <pre className="selectable mt-4 overflow-x-auto rounded-md bg-elevated p-3 font-mono text-xs text-primary">{JSON.stringify(draft.payload, null, 2)}</pre> : null}
              </div>

              {definition.confirmation === "checkbox" ? (
                <label className="flex items-start gap-2 rounded-md border border-default p-3 text-sm text-secondary"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5" /><span>Confirm {definition.label.toLowerCase()} for <code className="font-mono text-primary">{target}</code>.</span></label>
              ) : definition.confirmation === "type_target" && confirmationTarget ? (
                <div><label htmlFor="intervention-confirmation" className="block text-xs font-medium text-secondary">Type the exact target to confirm: <code className="font-mono text-primary">{confirmationTarget}</code></label><input id="intervention-confirmation" maxLength={2048} value={typedConfirmation} onChange={(event) => setTypedConfirmation(event.target.value)} autoComplete="off" className="mt-2 h-9 w-full rounded-md border border-default bg-canvas px-3 font-mono text-sm text-primary" /></div>
              ) : null}

              {error ? <p role="alert" className="text-xs" style={{ color: "var(--color-error)" }}>{error}</p> : null}
              <div className="flex justify-end gap-2 border-t border-subtle pt-4">
                <Button type="button" onClick={() => setStage("edit")} disabled={submitting} className="h-9 rounded-md px-3 text-sm text-secondary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45">Back</Button>
                <Button type="button" onClick={() => void createProposal()} disabled={!confirmationSatisfied || submitting} className="h-9 rounded-md border border-default bg-selected px-3 text-sm font-medium text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-45">{submitting ? "Creating" : "Create proposal"}</Button>
              </div>
            </div>
          ) : stage === "proposed" && proposal ? (
            <div className="space-y-4">
              <div role="status" className="rounded-lg border border-subtle bg-card p-4">
                <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Proposal created</h3><SemanticBadge tone="warning">{proposal.status}</SemanticBadge></div>
                <p className="mt-2 text-sm text-secondary">Proposal <code className="font-mono text-primary">{proposal.id}</code> exists on the control plane. It has not been applied.</p>
              </div>
              {error ? <p role="alert" className="text-xs" style={{ color: "var(--color-error)" }}>{error}</p> : null}
              <div className="flex justify-end gap-2 border-t border-subtle pt-4">
                <p className="mr-auto max-w-sm text-xs text-tertiary">Application unavailable: no kernel-backed intervention executor is configured.</p>
                <Button ref={proposedFocusRef} type="button" onClick={closeModal} className="h-9 rounded-md border border-default px-3 text-sm font-medium text-primary hover:bg-hover">Close</Button>
              </div>
            </div>
          ) : null}
        </div>
    </DialogSurface>
  );
}
