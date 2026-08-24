import { useCallback, useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { api, createIdempotencyKey } from "../lib/api";
import type {
  GatewayDeployment,
  GatewayProtocol,
  GatewayProviderConfiguration,
} from "../types";
import { Badge } from "../ui/Status";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { useModelInventory } from "../hooks/use-model-inventory";
import { formatContext, type ModelOption } from "../lib/models";

interface GatewayDraft {
  readonly deployment: GatewayDeployment;
  readonly protocol: GatewayProtocol;
  readonly model: string;
  readonly toolsEnabled: boolean;
  readonly freeModel: boolean;
  readonly workspaceAccess: boolean;
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
  credential: "",
  credentialConfigured: false,
  revision: 0,
};

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

  return (
    <section className="mb-4 border-t border-subtle pt-4" aria-label="OpenCode gateway configuration">
      <div className="flex items-start gap-3">
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-secondary">
          <KeyRound size={14} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="ui-section-title flex items-center gap-2 text-primary">
            OpenCode Zen and Go
            <Badge tone={draft.credentialConfigured ? "success" : "neutral"}>
              {loading ? "Loading" : draft.credentialConfigured ? "Connected" : "Not connected"}
            </Badge>
          </div>
          <p className="ui-meta mt-0.5">
            Uses your OpenCode gateway account inside the Terminus runtime. OpenCode itself is not launched.
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-2.5">
        <label className="ui-label grid gap-1 text-secondary">
          Account
          <Select
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
            })}
          />
        </label>
        <ModelField draft={draft} inventory={inventory} onChange={setDraft} />
        <label className="ui-label grid gap-1 text-secondary">
          Wire protocol
          <Select
            label="OpenCode wire protocol"
            value={draft.protocol}
            options={[
              { value: "chat_completions", label: "OpenAI Chat Completions" },
              { value: "responses", label: "OpenAI Responses" },
              { value: "messages", label: "Anthropic Messages" },
            ]}
            onValueChange={(value) => setDraft({ ...draft, protocol: value as GatewayProtocol })}
          />
        </label>
        <label className="ui-label grid gap-1 text-secondary">
          {draft.credentialConfigured ? "Replace OpenCode key" : "OpenCode key"}
          <Input
            aria-label="OpenCode key"
            type="password"
            autoComplete="off"
            value={draft.credential}
            placeholder={draft.credentialConfigured ? "Leave blank to keep the current key" : "Required"}
            onChange={(event) => setDraft({ ...draft, credential: event.target.value })}
          />
        </label>
        <div className="flex items-start justify-between gap-4 border-y border-subtle py-2.5">
          <div>
            <div className="ui-label text-secondary">Allow Terminus tools</div>
            <p className="ui-meta mt-0.5">The model uses Terminus read, patch, and bounded exec tools.</p>
          </div>
          <Switch
            checked={draft.toolsEnabled}
            onCheckedChange={(toolsEnabled) => setDraft({ ...draft, toolsEnabled })}
            label="Allow Terminus tools for OpenCode models"
          />
        </div>
        {/* Pricing is a fact about the model. Once discovery reports it, an
            operator switch here could only ever disagree with the provider and
            corrupt the routing ledger, so it becomes a read-out. */}
        {modelsFor(draft.deployment, inventory.models).some((model) => model.slug === draft.model) ? null : (
          <div className="flex items-start justify-between gap-4 border-b border-subtle pb-2.5">
            <div>
              <div className="ui-label text-secondary">Free model</div>
              <p className="ui-meta mt-0.5">Marks this exact model as zero-cost for routing records.</p>
            </div>
            <Switch
              checked={draft.freeModel}
              onCheckedChange={(freeModel) => setDraft({ ...draft, freeModel })}
              label="OpenCode model is free"
            />
          </div>
        )}
        <div className="flex items-start justify-between gap-4 border-b border-subtle pb-2.5">
          <div>
            <div className="ui-label text-secondary">Allow workspace content</div>
            <p className="ui-meta mt-0.5">Permits Terminus to send repository code and tool results to this provider.</p>
          </div>
          <Switch
            checked={draft.workspaceAccess}
            onCheckedChange={(workspaceAccess) => setDraft({ ...draft, workspaceAccess })}
            label="Allow OpenCode models to receive workspace content"
          />
        </div>
        {error ? <p className="text-error text-xs" role="alert">{error}</p> : null}
        <div className="flex gap-2">
          <Button onClick={() => void save()} disabled={loading || saving} variant="secondary" size="sm">
            {saving ? "Saving…" : draft.credentialConfigured ? "Save OpenCode settings" : "Connect OpenCode"}
          </Button>
          {draft.credentialConfigured ? (
            <Button onClick={() => void disconnect()} disabled={loading || saving} variant="ghost" size="sm">
              Disconnect
            </Button>
          ) : null}
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
    credential: "",
    credentialConfigured: configuration.credential_configured,
    revision: configuration.revision,
  };
}

/** Models the inventory reported for this deployment's gateway. */
function modelsFor(
  deployment: GatewayDeployment,
  models: readonly ModelOption[],
): readonly ModelOption[] {
  const providerId = deployment === "zen" ? "open_code_zen" : "open_code_go";
  return models.filter((model) => model.provider === providerId);
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
  const available = modelsFor(draft.deployment, inventory.models);
  const selected = available.find((model) => model.slug === draft.model) ?? null;

  if (available.length === 0) {
    return (
      <label className="ui-label grid gap-1 text-secondary">
        Model
        <Input
          aria-label="OpenCode model"
          value={draft.model}
          placeholder="Model ID from OpenCode"
          onChange={(event) => onChange({ ...draft, model: event.target.value })}
        />
        <p className="ui-meta">
          {inventory.status === "loading"
            ? "Checking which models this key can reach…"
            : `${inventory.error ?? "No models were reported."} Enter the id manually.`}
        </p>
      </label>
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
    <label className="ui-label grid gap-1 text-secondary">
      Model
      <Select
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
      />
      <p className="ui-meta">
        {draft.model === ""
          ? `${available.length} model${available.length === 1 ? "" : "s"} reachable with this key.`
          : selected === null
          ? "This model was not in the gateway's list."
          : [
              selected.free ? "Free" : null,
              formatContext(selected.contextTokens) ? `${formatContext(selected.contextTokens)} context` : null,
              selected.reasoning ? "Reasoning" : null,
              selected.toolCalling ? "Tools" : null,
            ].filter(Boolean).join(" · ")}
      </p>
    </label>
  );
}
