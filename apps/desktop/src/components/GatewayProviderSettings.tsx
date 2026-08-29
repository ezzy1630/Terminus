/**
 * Terminus Desktop — OpenCode gateway provider.
 *
 * Drawn in the same System Settings language as the rest of the pane: a
 * sentence-case group heading, then hairline-separated rows of label-left,
 * control-right. Every control here round-trips through the control plane
 * (`GET`/`PUT`/`DELETE /v1/gateway-provider-config`), so the status line
 * reports what the server stores, not a local guess.
 *
 * One honesty note that outlives any restyle: "Connected" means a credential
 * is stored, not that it works. There is no probe route, so the label says
 * "Key stored" rather than claiming a verified connection.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, createIdempotencyKey } from "../lib/api";
import { GATEWAY_PRIVACY_TERMS_VERSIONS } from "../types";
import type {
  GatewayDeployment,
  GatewayProtocol,
  GatewayProviderConfiguration,
} from "../types";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { useModelInventory } from "../hooks/use-model-inventory";
import { formatContext, type ModelInventory, type ModelOption } from "../lib/models";

interface GatewayDraft {
  readonly deployment: GatewayDeployment;
  readonly protocol: GatewayProtocol;
  readonly model: string;
  readonly toolsEnabled: boolean;
  readonly freeModel: boolean;
  readonly workspaceAccess: boolean;
  readonly privacyTermsAdmitted: boolean;
  readonly privacyTermsVersion: string | null;
  readonly credential: string;
  readonly credentialConfigured: boolean;
  readonly revision: number;
}

const EMPTY_DRAFT: GatewayDraft = {
  deployment: "zen",
  protocol: "chat_completions",
  model: "",
  toolsEnabled: true,
  freeModel: true,
  workspaceAccess: false,
  privacyTermsAdmitted: false,
  privacyTermsVersion: null,
  credential: "",
  credentialConfigured: false,
  revision: 0,
};

/**
 * The settings row shell, kept local on purpose.
 *
 * Settings.tsx renders this component, so importing its layout helpers back
 * out of it would close an import cycle. The shape is three lines of markup;
 * a cycle is not worth avoiding six duplicated ones.
 */
function Field({
  controlId,
  label,
  description,
  children,
}: {
  controlId?: string;
  label: string;
  description?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-10 items-center gap-4 py-1.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {controlId ? (
          <label htmlFor={controlId} className="ui-body text-primary">{label}</label>
        ) : (
          <span className="ui-body text-primary">{label}</span>
        )}
        {description ? <p className="ui-meta">{description}</p> : null}
      </div>
      <div className="flex flex-shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

export function GatewayProviderSettings(): JSX.Element {
  const [draft, setDraft] = useState<GatewayDraft>(EMPTY_DRAFT);
  const inventory = useModelInventory();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api.getGatewayProviderConfiguration(controller.signal).then((response) => {
      if (controller.signal.aborted || response.configuration === null) return;
      setDraft(draftFromConfiguration(response.configuration));
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : "OpenCode gateway configuration could not be loaded.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  const save = useCallback(async (): Promise<void> => {
    if (draft.model.trim().length === 0) {
      setError("Model is required.");
      return;
    }
    if (!draft.credentialConfigured && draft.credential.length === 0) {
      setError("OpenCode key is required the first time you connect this account.");
      return;
    }
    const currentTermsVersion = GATEWAY_PRIVACY_TERMS_VERSIONS[draft.deployment];
    if (draft.workspaceAccess && (
      !draft.privacyTermsAdmitted
      || draft.privacyTermsVersion !== currentTermsVersion
    )) {
      setError("Review and admit the current provider privacy terms before allowing workspace content.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await api.putGatewayProviderConfiguration({
        deployment: draft.deployment,
        protocol: draft.protocol,
        model: draft.model.trim(),
        tools_enabled: draft.toolsEnabled,
        free_model: draft.freeModel,
        workspace_access: draft.workspaceAccess,
        privacy_terms_admitted: draft.privacyTermsAdmitted,
        privacy_terms_version: draft.privacyTermsVersion,
        ...(draft.credential.length > 0 ? { credential: draft.credential } : {}),
        expected_revision: draft.revision,
      }, { idempotencyKey: createIdempotencyKey("gateway-provider-config") });
      if (response.configuration === null) throw new Error("Gateway configuration update returned no row.");
      setDraft(draftFromConfiguration(response.configuration));
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "OpenCode gateway configuration could not be saved.");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const disconnect = useCallback(async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await api.deleteGatewayProviderConfiguration(
        draft.revision,
        { idempotencyKey: createIdempotencyKey("gateway-provider-disconnect") },
      );
      setDraft(EMPTY_DRAFT);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "OpenCode gateway could not be disconnected.");
    } finally {
      setSaving(false);
    }
  }, [draft.revision]);

  const termsCurrent = draft.privacyTermsAdmitted
    && draft.privacyTermsVersion === GATEWAY_PRIVACY_TERMS_VERSIONS[draft.deployment];

  return (
    <section className="mb-6" aria-label="OpenCode gateway configuration">
      <h2 className="mb-1.5 text-sm text-tertiary">OpenCode gateway</h2>
      <div className="divide-y divide-[var(--border-subtle)] border-y border-subtle">
        <Field
          label="OpenCode Zen and Go"
          description="Uses your OpenCode gateway account inside the Terminus runtime. OpenCode itself is not launched."
        >
          <span className={draft.credentialConfigured ? "ui-body text-primary" : "ui-body text-tertiary"}>
            {loading ? "Checking…" : draft.credentialConfigured ? "Key stored" : "Not connected"}
          </span>
        </Field>

        <Field controlId="gateway-account" label="Account">
          <Select
            id="gateway-account"
            label="OpenCode account"
            value={draft.deployment}
            options={[
              { value: "zen", label: "Zen" },
              { value: "go", label: "Go subscription" },
            ]}
            onValueChange={(value) => setDraft({
              ...draft,
              deployment: value as GatewayDeployment,
              credential: "",
              credentialConfigured: value === draft.deployment && draft.credentialConfigured,
              freeModel: value === "zen",
              privacyTermsAdmitted: false,
              privacyTermsVersion: null,
            })}
          />
        </Field>

        <ModelField draft={draft} inventory={inventory} onChange={setDraft} />

        <Field controlId="gateway-protocol" label="Wire protocol">
          <Select
            id="gateway-protocol"
            label="OpenCode wire protocol"
            value={draft.protocol}
            options={[
              { value: "chat_completions", label: "OpenAI Chat Completions" },
              { value: "responses", label: "OpenAI Responses" },
              { value: "messages", label: "Anthropic Messages" },
            ]}
            onValueChange={(value) => setDraft({ ...draft, protocol: value as GatewayProtocol })}
          />
        </Field>

        <Field
          controlId="gateway-key"
          label={draft.credentialConfigured ? "Replace key" : "OpenCode key"}
          description={draft.credentialConfigured ? "Leave blank to keep the current key." : undefined}
        >
          <Input
            id="gateway-key"
            aria-label="OpenCode key"
            type="password"
            autoComplete="off"
            value={draft.credential}
            placeholder={draft.credentialConfigured ? "Unchanged" : "Required"}
            onChange={(event) => setDraft({ ...draft, credential: event.target.value })}
            className="w-56 font-mono"
          />
        </Field>

        <Field
          controlId="gateway-tools"
          label="Allow Terminus tools"
          description="The model uses Terminus read, patch, and bounded exec tools."
        >
          <Switch
            id="gateway-tools"
            checked={draft.toolsEnabled}
            onCheckedChange={(toolsEnabled) => setDraft({ ...draft, toolsEnabled })}
            label="Allow Terminus tools for OpenCode models"
          />
        </Field>

        {/* Pricing is a fact about the model. Once discovery reports it, an
            operator switch here could only ever disagree with the provider and
            corrupt the routing ledger, so it becomes a read-out. */}
        {modelsFor(draft.deployment, inventory).some((model) => model.slug === draft.model) ? null : (
          <Field
            controlId="gateway-free-model"
            label="Free model"
            description="Marks this exact model as zero-cost for routing records."
          >
            <Switch
              id="gateway-free-model"
              checked={draft.freeModel}
              onCheckedChange={(freeModel) => setDraft({ ...draft, freeModel })}
              label="OpenCode model is free"
            />
          </Field>
        )}

        <Field
          controlId="gateway-privacy-terms"
          label="Provider privacy terms"
          description={`Admit the current ${draft.deployment === "zen" ? "Zen" : "Go"} terms (${GATEWAY_PRIVACY_TERMS_VERSIONS[draft.deployment]}) before repository code or tool results can leave Terminus.`}
        >
          <input
            id="gateway-privacy-terms"
            type="checkbox"
            className="h-3.5 w-3.5 accent-[var(--accent)]"
            aria-label="I reviewed the current provider privacy and retention terms"
            checked={termsCurrent}
            onChange={(event) => {
              const admitted = event.target.checked;
              setDraft({
                ...draft,
                privacyTermsAdmitted: admitted,
                privacyTermsVersion: admitted ? GATEWAY_PRIVACY_TERMS_VERSIONS[draft.deployment] : null,
                workspaceAccess: admitted ? draft.workspaceAccess : false,
              });
            }}
          />
        </Field>

        <Field
          controlId="gateway-workspace-access"
          label="Allow workspace content"
          description="Permits Terminus to send repository code and tool results to this provider."
        >
          <Switch
            id="gateway-workspace-access"
            checked={draft.workspaceAccess}
            disabled={!termsCurrent}
            onCheckedChange={(workspaceAccess) => setDraft({ ...draft, workspaceAccess })}
            label="Allow OpenCode models to receive workspace content"
          />
        </Field>

        <div className="flex flex-col gap-2 py-2.5">
          {error ? <p className="text-xs text-error" role="alert">{error}</p> : null}
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={loading || saving} variant="secondary" size="sm">
              {saving ? "Saving…" : draft.credentialConfigured ? "Save" : "Connect"}
            </Button>
            {draft.credentialConfigured ? (
              <Button onClick={() => void disconnect()} disabled={loading || saving} variant="ghost" size="sm">
                Disconnect
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function draftFromConfiguration(configuration: GatewayProviderConfiguration): GatewayDraft {
  return {
    deployment: configuration.deployment,
    protocol: configuration.protocol,
    model: configuration.model,
    toolsEnabled: configuration.tools_enabled,
    freeModel: configuration.free_model,
    workspaceAccess: configuration.workspace_access,
    privacyTermsAdmitted: configuration.privacy_terms_admitted,
    privacyTermsVersion: configuration.privacy_terms_version,
    credential: "",
    credentialConfigured: configuration.credential_configured,
    revision: configuration.revision,
  };
}

/**
 * Models the inventory reported for this deployment's gateway.
 *
 * Two spellings, because the inventory has two eras. Before connected accounts
 * the gateway was a fixed provider id; now it is an account whose *source* is
 * `zen`, with an opaque id. Matching on both keeps this form working against
 * either control plane instead of silently falling back to a text field.
 */
function modelsFor(
  deployment: GatewayDeployment,
  inventory: ModelInventory,
): readonly ModelOption[] {
  const legacyId = deployment === "zen" ? "open_code_zen" : "open_code_go";
  const accountIds = new Set(
    inventory.providers
      .filter((provider) => provider.id === legacyId || (deployment === "zen" && provider.source === "zen"))
      .map((provider) => provider.id),
  );
  accountIds.add(legacyId);
  return inventory.models.filter((model) => accountIds.has(model.provider));
}

/**
 * The model field, discovered where possible.
 *
 * Typing a model id by hand is how this worked before there was an inventory,
 * and it is still the only option when discovery cannot run — so the text
 * input stays as the fallback rather than leaving an operator with no way to
 * configure a gateway. When the list is available it is authoritative: `free`
 * and tool support come from the provider instead of two switches an operator
 * had to keep in sync by hand.
 */
function ModelField({
  draft,
  inventory,
  onChange,
}: {
  draft: GatewayDraft;
  inventory: ReturnType<typeof useModelInventory>;
  onChange: (draft: GatewayDraft) => void;
}): JSX.Element {
  const available = modelsFor(draft.deployment, inventory);
  const selected = available.find((model) => model.slug === draft.model) ?? null;

  if (available.length === 0) {
    return (
      <Field
        controlId="gateway-model"
        label="Model"
        description={inventory.status === "loading"
          ? "Checking which models this key can reach…"
          : `${inventory.error ?? "No models were reported."} Enter the id manually.`}
      >
        <Input
          id="gateway-model"
          aria-label="OpenCode model"
          value={draft.model}
          placeholder="Model ID from OpenCode"
          onChange={(event) => onChange({ ...draft, model: event.target.value })}
          className="w-56 font-mono"
        />
      </Field>
    );
  }

  // A saved model the gateway no longer lists must stay visible and selected;
  // dropping it would silently show a different model than the one running.
  const options = [
    ...available.map((model) => ({ value: model.slug, label: model.label })),
    ...(draft.model !== "" && selected === null
      ? [{ value: draft.model, label: `${draft.model} (not reported by the gateway)` }]
      : []),
  ];

  return (
    <Field
      controlId="gateway-model"
      label="Model"
      description={draft.model === ""
        ? `${available.length} model${available.length === 1 ? "" : "s"} reachable with this key.`
        : selected === null
        ? "This model was not in the gateway's list."
        : [
            selected.free ? "Free" : null,
            formatContext(selected.contextTokens) ? `${formatContext(selected.contextTokens)} context` : null,
            selected.reasoning ? "Reasoning" : null,
            selected.toolCalling ? "Tools" : null,
          ].filter(Boolean).join(" · ")}
    >
      <Select
        id="gateway-model"
        label="OpenCode model"
        value={draft.model}
        options={options}
        onValueChange={(value) => {
          const picked = available.find((model) => model.slug === value) ?? null;
          onChange({
            ...draft,
            model: value,
            // Both are properties of the chosen model. Carrying the previous
            // model's answers forward is what made these switches drift.
            freeModel: picked?.free ?? draft.freeModel,
            toolsEnabled: picked === null ? draft.toolsEnabled : draft.toolsEnabled && picked.toolCalling === true,
          });
        }}
        className="max-w-56"
      />
    </Field>
  );
}
