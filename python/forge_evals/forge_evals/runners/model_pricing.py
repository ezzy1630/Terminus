"""Resolve a model's price table and compute the cost of one run.

Three sources, tried in order, with the winning one recorded on the run so a
cost figure is always attributable:

1. ``GET /v1/provider-models`` on the control plane — ``input_micros_per_million``
   / ``output_micros_per_million``. The control plane omits these for
   subscription-billed accounts (``provider-account-models.ts:647-654``), which
   is exactly the ChatGPT-subscription path used for the GPT-5.6 baseline, so
   this source is frequently empty by design and never carries a cached-input
   rate.
2. ``evals/registry.yaml`` → ``model_pricing`` — the eval lab's own price of
   record, in USD per million tokens, including the cached-input rate.
3. ``packages/provider-core/src/catalog/models_dev_snapshot.json`` — the
   committed models.dev snapshot the runtime itself ships
   (``cost.input`` / ``cost.output`` / ``cost.cache_read``, USD per million).

The arithmetic mirrors the control plane's own
``computeExactCostMicros`` (``packages/provider-core/src/index.ts:284-325``):
cached input tokens are a **subset** of input tokens and are billed at the
cached rate; the remainder is billed at the input rate; reasoning tokens are
billed at the output rate **only** when the model's accounting treats them as
separate from output tokens.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = [
    "ModelPrices",
    "compute_cost",
    "load_registry_pricing",
    "prices_from_control_plane_models",
    "resolve_model_prices",
]

_REPO_ROOT = Path(__file__).resolve().parents[4]
_REGISTRY_PATH = _REPO_ROOT / "evals" / "registry.yaml"
_SNAPSHOT_PATH = (
    _REPO_ROOT / "packages" / "provider-core" / "src" / "catalog" / "models_dev_snapshot.json"
)


@dataclass(frozen=True)
class ModelPrices:
    """USD-per-million-token rates for one model, plus their provenance."""

    model: str
    input_usd_per_mtok: float
    output_usd_per_mtok: float
    cached_input_usd_per_mtok: float
    source: str
    reasoning_accounting: bool = False

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe form recorded on the run's model capability snapshot."""
        return {
            "model": self.model,
            "input": self.input_usd_per_mtok,
            "output": self.output_usd_per_mtok,
            "cached": self.cached_input_usd_per_mtok,
            "reasoning_accounting": self.reasoning_accounting,
            "source": self.source,
        }


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def prices_from_control_plane_models(
    catalog: Mapping[str, Any] | None,
    model: str,
) -> ModelPrices | None:
    """Read a model's rates from a ``GET /v1/provider-models`` response.

    Since Phase 0-F2 each model row carries a ``pricing`` object and a
    ``pricing_source``, so "no price" is stated instead of inferred:
    ``pricing: null`` with ``pricing_source: "subscription"`` means the account
    has no per-token rate at all (the ChatGPT/Codex path), and the caller falls
    through to the registry's price table. Absent fields used to be
    indistinguishable from "discovery has not reported one yet", and the
    cached-input rate had to be assumed equal to fresh input — a ~10x
    overstatement of the cached portion of a well-cached turn.
    """
    if not isinstance(catalog, Mapping):
        return None
    models = catalog.get("models")
    if not isinstance(models, list):
        return None
    wanted = model.strip().lower()
    for entry in models:
        if not isinstance(entry, Mapping):
            continue
        candidates = {
            str(entry.get(key) or "").strip().lower() for key in ("id", "slug", "label")
        }
        if wanted not in candidates:
            continue
        pricing = entry.get("pricing")
        if not isinstance(pricing, Mapping):
            return None
        input_micros = _as_float(pricing.get("input_micros_per_million"))
        output_micros = _as_float(pricing.get("output_micros_per_million"))
        cached_micros = _as_float(pricing.get("cached_input_micros_per_million"))
        if input_micros is None or output_micros is None or cached_micros is None:
            return None
        if input_micros <= 0.0 and output_micros <= 0.0:
            return None
        source = str(entry.get("pricing_source") or "catalog")
        return ModelPrices(
            model=model,
            input_usd_per_mtok=input_micros / 1_000_000.0,
            output_usd_per_mtok=output_micros / 1_000_000.0,
            cached_input_usd_per_mtok=cached_micros / 1_000_000.0,
            source=f"control_plane:/v1/provider-models:{source}",
        )
    return None


def load_registry_pricing(registry_path: Path | str | None = None) -> dict[str, ModelPrices]:
    """Load ``evals/registry.yaml``'s ``model_pricing`` block."""
    path = Path(registry_path) if registry_path is not None else _REGISTRY_PATH
    if not path.exists():
        return {}
    import yaml

    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(raw, Mapping):
        return {}
    block = raw.get("model_pricing")
    if not isinstance(block, Mapping):
        return {}
    out: dict[str, ModelPrices] = {}
    for model, entry in block.items():
        if not isinstance(entry, Mapping):
            continue
        input_rate = _as_float(entry.get("input_usd_per_mtok"))
        output_rate = _as_float(entry.get("output_usd_per_mtok"))
        if input_rate is None or output_rate is None:
            continue
        cached_rate = _as_float(entry.get("cached_input_usd_per_mtok"))
        out[str(model).strip().lower()] = ModelPrices(
            model=str(model),
            input_usd_per_mtok=input_rate,
            output_usd_per_mtok=output_rate,
            cached_input_usd_per_mtok=cached_rate if cached_rate is not None else input_rate,
            source=f"registry:{path.name}#model_pricing",
            reasoning_accounting=bool(entry.get("reasoning_accounting", False)),
        )
    return out


def load_snapshot_pricing(snapshot_path: Path | str | None = None) -> dict[str, ModelPrices]:
    """Load the committed models.dev snapshot the runtime ships."""
    path = Path(snapshot_path) if snapshot_path is not None else _SNAPSHOT_PATH
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return {}
    if not isinstance(raw, Mapping):
        return {}
    out: dict[str, ModelPrices] = {}
    for provider, provider_entry in raw.items():
        if not isinstance(provider_entry, Mapping):
            continue
        models = provider_entry.get("models")
        if not isinstance(models, Mapping):
            continue
        for model_id, model_entry in models.items():
            if not isinstance(model_entry, Mapping):
                continue
            cost = model_entry.get("cost")
            if not isinstance(cost, Mapping):
                continue
            input_rate = _as_float(cost.get("input"))
            output_rate = _as_float(cost.get("output"))
            if input_rate is None or output_rate is None:
                continue
            cached_rate = _as_float(cost.get("cache_read"))
            prices = ModelPrices(
                model=str(model_id),
                input_usd_per_mtok=input_rate,
                output_usd_per_mtok=output_rate,
                cached_input_usd_per_mtok=cached_rate if cached_rate is not None else input_rate,
                source=f"models_dev_snapshot:{provider}",
            )
            out.setdefault(str(model_id).strip().lower(), prices)
    return out


def resolve_model_prices(
    model: str,
    *,
    catalog: Mapping[str, Any] | None = None,
    registry_path: Path | str | None = None,
    snapshot_path: Path | str | None = None,
) -> ModelPrices | None:
    """Resolve a model's rates from the first source that has them.

    Returns ``None`` when no source prices the model. Callers must record the
    run's cost as unavailable rather than invent a rate.
    """
    from_catalog = prices_from_control_plane_models(catalog, model)
    if from_catalog is not None:
        return from_catalog
    key = model.strip().lower()
    registry = load_registry_pricing(registry_path)
    if key in registry:
        return registry[key]
    snapshot = load_snapshot_pricing(snapshot_path)
    if key in snapshot:
        return snapshot[key]
    # Family fallback: `gpt-5.6-codex` resolves to `gpt-5.6` when the exact
    # deployment id is not priced, so a Codex-dialect run still gets a cost.
    for table in (registry, snapshot):
        for candidate_key, prices in table.items():
            if key.startswith(candidate_key + "-") or key.startswith(candidate_key + ":"):
                return prices
    return None


def compute_cost(
    prices: ModelPrices,
    *,
    tokens_input_fresh: int,
    tokens_input_cached: int,
    tokens_output: int,
    tokens_reasoning: int,
) -> float:
    """Compute a run's USD cost using the control plane's own formula."""
    cost = (
        tokens_input_fresh / 1_000_000.0 * prices.input_usd_per_mtok
        + tokens_input_cached / 1_000_000.0 * prices.cached_input_usd_per_mtok
        + tokens_output / 1_000_000.0 * prices.output_usd_per_mtok
    )
    if prices.reasoning_accounting:
        cost += tokens_reasoning / 1_000_000.0 * prices.output_usd_per_mtok
    return round(cost, 8)
