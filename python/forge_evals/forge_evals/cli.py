"""SPEC §41 / §43.7 ``terminus-eval`` command-line interface.

Built with :mod:`argparse` (no Click/Typer dependency, keeping the install
footprint small). Provides commands for the standard eval workflow:

- ``terminus-eval run`` — run a single harness on a task.
- ``terminus-eval compare`` — run an identity-locked paired live campaign.
- ``terminus-eval bench-check`` — validate external benchmark suite manifests
  through their adapters (offline; no harness or credentials required).
- ``terminus-eval aggregate`` — aggregate JSONL run records into a summary.
- ``terminus-eval dashboard`` — generate a cohort dashboard HTML.
- ``terminus-eval promote`` — evaluate the promotion gate.
- ``terminus-eval regression`` — compare two run sets for regressions.

All commands are deterministic given the same inputs and seeds.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
from collections.abc import Sequence
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .analysis.aggregate import summarize_runs
from .analysis.load_runs import (
    RunCatalog,
    load_runs_from_json_dir,
    load_runs_from_jsonl,
    load_runs_from_parquet,
)
from .analysis.regression_detector import detect_regressions
from .conformance_levels import ConformanceEvidence, ConformanceLevel, assess_conformance
from .dashboards.cohort_dashboard import write_cohort_dashboard
from .dashboards.security_report import compute_security_report, write_security_report
from .eval_tiers import EvalTier, get_tier_config, list_all_tiers
from .experiment_manifest import ChangeManifest, Decision
from .promotion_gate import (
    Evaluation,
    PromotionDecision,
    PromotionGateResult,
    evaluate_promotion,
)
from .run_record import Outcome, RunRecord
from .runners import (
    Budgets,
    FakeScriptHarness,
    GraderOutcome,
    HarnessResult,
    HarnessRunner,
    ModelCapabilitySnapshot,
    RunRequest,
    build_evaluation_identity,
    make_default_cost,
    select_harness,
)

__all__ = ["main"]


# ──────────────────────────── main ────────────────────────────────────────


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entrypoint — returns the process exit code."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 1
    try:
        return _dispatch(args)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130
    except Exception as exc:  # pragma: no cover — defensive
        print(f"error: {exc}", file=sys.stderr)
        return 1


def _build_parser() -> argparse.ArgumentParser:
    """Build the top-level argparse parser."""
    p = argparse.ArgumentParser(
        prog="terminus-eval",
        description="Terminus offline evaluation laboratory (SPEC §18, §41, §43.3).",
    )
    sub = p.add_subparsers(dest="command", required=False)
    _add_run_cmd(sub)
    _add_compare_cmd(sub)
    _add_aggregate_cmd(sub)
    _add_dashboard_cmd(sub)
    _add_promote_cmd(sub)
    _add_regression_cmd(sub)
    _add_security_cmd(sub)
    _add_tier_cmd(sub)
    _add_exit_gate_cmd(sub)
    _add_conformance_cmd(sub)
    _add_bench_check_cmd(sub)
    return p


# ──────────────────────────── tier & exit-gate ────────────────────────────


def _add_tier_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    p = sub.add_parser("tier", help="Inspect or display evaluation tier configurations.")
    p.add_argument("--name", choices=[t.value for t in EvalTier], default=None, help="Tier name.")


def _cmd_tier(args: argparse.Namespace) -> int:
    if args.name:
        cfg = get_tier_config(args.name)
        _write_json(cfg.to_dict(), "-")
    else:
        configs = [c.to_dict() for c in list_all_tiers()]
        _write_json(configs, "-")
    return 0


def _add_exit_gate_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    p = sub.add_parser(
        "exit-gate",
        help="Validate local run evidence without claiming the signed release gate.",
    )
    p.add_argument("--runs-dir", default=None, help="Directory of immutable run records to check.")


def _cmd_exit_gate(args: argparse.Namespace) -> int:
    if args.runs_dir is None:
        print("LOCAL EVIDENCE CHECK: BLOCKED", file=sys.stderr)
        print("--runs-dir is required; no release claim was evaluated", file=sys.stderr)
        return 2

    catalog = _load_runs_dir(args.runs_dir)
    if catalog.n == 0:
        print("LOCAL EVIDENCE CHECK: BLOCKED", file=sys.stderr)
        print(f"no run records found in {args.runs_dir}", file=sys.stderr)
        return 2

    issues = _local_exit_gate_issues(catalog.records)
    if issues:
        print("LOCAL EVIDENCE CHECK: FAIL", file=sys.stderr)
        for issue in issues:
            print(f"- {issue}", file=sys.stderr)
        print("RELEASE EXIT GATE: UNVERIFIED", file=sys.stderr)
        return 1

    print(f"LOCAL EVIDENCE CHECK: PASS ({catalog.n} records)")
    print(
        "RELEASE EXIT GATE: UNVERIFIED; signed CI, security, durability, UX, "
        "and external reproduction evidence are separate requirements"
    )
    return 0


def _local_exit_gate_issues(records: Sequence[RunRecord]) -> list[str]:
    """Return structural defects that make local evaluation evidence unusable."""

    issues: list[str] = []
    seeds_by_cell: dict[tuple[str, str, str, str], set[int]] = {}
    exact_revision = re.compile(r"(?:(?:git:)?(?:[0-9a-f]{40}|[0-9a-f]{64})|sha256:[0-9a-f]{64})")
    content_digest = re.compile(r"sha256:[0-9a-f]{64}")
    for record in records:
        revision = record.harness_commit.strip().lower()
        if exact_revision.fullmatch(revision) is None:
            issues.append(f"{record.run_id}: harness revision is not exact")
        if content_digest.fullmatch(record.environment_digest) is None:
            issues.append(f"{record.run_id}: environment digest is not content-addressed")
        if record.end is None:
            issues.append(f"{record.run_id}: run has no terminal timestamp")
        if not record.grader_results:
            issues.append(f"{record.run_id}: no independent grader result")
        elif any(result.grader_id == "end_state.noop" for result in record.grader_results):
            issues.append(f"{record.run_id}: fixture noop grader is not admissible evidence")
        if "fixture" in record.notes.lower() or "fake" in record.notes.lower():
            issues.append(f"{record.run_id}: fixture harness output is not admissible evidence")
        if record.cost is None:
            issues.append(f"{record.run_id}: no cost/token accounting")
        cell = (record.suite, record.task, record.harness, record.harness_commit)
        seeds_by_cell.setdefault(cell, set()).add(record.random_seed)

    for cell, seeds in sorted(seeds_by_cell.items()):
        if len(seeds) < 5:
            suite, task, harness, _revision = cell
            issues.append(
                f"{suite}/{task}/{harness}: {len(seeds)} independent seeds; at least 5 required"
            )
    return issues


def _add_conformance_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    p = sub.add_parser(
        "conformance",
        help="Structurally inspect candidate L0-L6 receipts without claiming signature proof.",
    )
    p.add_argument("--evidence", required=True, help="JSON array of conformance receipts.")
    p.add_argument("--commit", required=True, help="Exact Git object hash.")
    p.add_argument("--platform", required=True, help="Exact platform/environment identifier.")
    p.add_argument("--as-of", required=True, help="Timezone-aware ISO-8601 assessment time.")
    p.add_argument("--output", default="-", help="Output path or '-' for stdout.")
    p.add_argument(
        "--require-level",
        choices=[level.name for level in ConformanceLevel],
        default=None,
        help="Fail closed unless an externally verified assessment proves this level.",
    )


def _cmd_conformance(args: argparse.Namespace) -> int:
    raw = json.loads(Path(args.evidence).read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("conformance evidence must be a JSON array")
    receipts = [ConformanceEvidence.from_dict(item) for item in raw if isinstance(item, dict)]
    if len(receipts) != len(raw):
        raise ValueError("every conformance evidence item must be an object")
    assessment = assess_conformance(
        receipts,
        commit=args.commit,
        platform=args.platform,
        now=datetime.fromisoformat(args.as_of),
    )
    _write_json(assessment.to_system_card_fragment(), args.output)
    if args.require_level is None:
        return 0
    # This offline command performs structural inspection only. Release gates
    # require the separate trusted verifier and therefore always fail closed.
    return 1


# ──────────────────────────── run ─────────────────────────────────────────


# ──────────────────────────── run ─────────────────────────────────────────


def _add_run_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    """Add the ``run`` subcommand."""
    p = sub.add_parser("run", help="Run a single harness on a benchmark task.")
    p.add_argument("--suite", required=True, help="Suite id (e.g. tiny-bugfix).")
    p.add_argument("--task", required=True, help="Task id.")
    p.add_argument("--task-dir", required=True, help="Path to the task package directory.")
    p.add_argument(
        "--harness",
        required=True,
        help="Harness id (terminus-minimal, terminus-full, or external baseline id).",
    )
    p.add_argument("--harness-commit", default="git:HEAD", help="Harness commit / version pin.")
    p.add_argument("--seeds", type=int, default=1, help="Number of independent seeds.")
    p.add_argument("--seed", type=int, default=42, help="Starting seed.")
    p.add_argument("--provider", default="fake", help="Provider id.")
    p.add_argument("--model", default="fake-1", help="Model id.")
    p.add_argument(
        "--effort",
        choices=["low", "medium", "high", "max"],
        default=None,
        help="Reasoning effort; sets the turn's reasoning_effort and the "
        "session's default_reasoning_effort.",
    )
    p.add_argument(
        "--provider-account",
        default=None,
        help="Pin the provider account id that must serve --model "
        "(default: the account whose catalog lists the model).",
    )
    p.add_argument(
        "--max-steps",
        type=int,
        default=None,
        help="Per-turn tool-call ceiling, sent as POST /v1/turns budget.max_steps "
        "and enforced by the control plane (it may only tighten the task "
        "contract's own budget, never raise it).",
    )
    p.add_argument(
        "--max-tokens",
        type=int,
        default=None,
        help="Per-turn total token ceiling, sent as POST /v1/turns "
        "budget.max_tokens and enforced by the control plane.",
    )
    p.add_argument(
        "--fixture-mode",
        action="store_true",
        help="Explicitly run the deterministic fake harness; output is never release evidence.",
    )
    p.add_argument(
        "--workspace",
        default=None,
        help="Scratch workspace the task is materialised into and graded in "
        "(default: <output-dir>/workspaces/<suite>/<task>/<seed>).",
    )
    p.add_argument(
        "--no-setup",
        action="store_true",
        help="Do not run the task package's setup.sh; grade the task directory in place.",
    )
    p.add_argument(
        "--instance-file",
        default=None,
        help="SWE-bench Pro: path to a JSON/JSONL file of instance records "
        "(instance_id, repo, base_commit, problem_statement, ...).",
    )
    p.add_argument("--output-dir", default="evals/results", help="Directory to write run records.")
    p.add_argument(
        "--format",
        choices=["json", "jsonl", "parquet"],
        default="jsonl",
        help="Output format for run records.",
    )


def _add_compare_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    """Add the fail-closed cross-harness campaign command."""
    p = sub.add_parser(
        "compare",
        help="Run the same materialized task through live Terminus/OpenCode/Pi harnesses.",
    )
    p.add_argument("--suite", required=True)
    p.add_argument("--task", required=True)
    p.add_argument("--task-dir", required=True)
    p.add_argument(
        "--harness",
        action="append",
        required=True,
        choices=["terminus-live", "upstream-opencode", "pi"],
    )
    p.add_argument("--candidate-harness", required=True)
    p.add_argument(
        "--harness-pin",
        action="append",
        required=True,
        metavar="HARNESS=REVISION",
        help="Repeat once per harness; revision must be an exact Git or sha256 identity.",
    )
    p.add_argument(
        "--harness-provider-account",
        action="append",
        default=[],
        metavar="HARNESS=ACCOUNT_ID",
    )
    p.add_argument(
        "--harness-provider-endpoint",
        action="append",
        default=[],
        metavar="HARNESS=ENDPOINT",
        help="Provider endpoint identity for each harness; raw values are hashed in evidence.",
    )
    p.add_argument(
        "--harness-artifact",
        action="append",
        default=[],
        metavar="HARNESS=PATH",
        help="Exact executable or runtime artifact used by each strict campaign harness.",
    )
    p.add_argument(
        "--harness-artifact-digest",
        action="append",
        default=[],
        metavar="HARNESS=SHA256",
        help="Expected sha256 digest for each strict campaign harness artifact.",
    )
    p.add_argument(
        "--isolation-attestation",
        default=None,
        help="Externally produced isolation attestation JSON required by --strict-evidence.",
    )
    p.add_argument(
        "--strict-evidence",
        action="store_true",
        help="Require executable digests, provider bindings, and an external isolation attestation.",
    )
    p.add_argument(
        "--provider-alias",
        action="append",
        default=[],
        metavar="HARNESS=PROVIDER_ID",
        help="Allow a server-resolved provider id to map to the canonical provider.",
    )
    p.add_argument("--provider", required=True, help="Canonical model provider id.")
    p.add_argument("--model", required=True)
    p.add_argument("--api-version", default="catalog-1")
    p.add_argument("--effort", choices=["low", "medium", "high", "max"], default="high")
    p.add_argument("--seeds", type=int, default=1)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--max-steps", type=int, default=50)
    p.add_argument("--max-tokens", type=int, default=200_000)
    p.add_argument("--max-wall-seconds", type=int, default=300)
    p.add_argument("--holdout-partition", default="local_diagnostic")
    p.add_argument("--provider-route", default="anonymous-shared-backend")
    p.add_argument("--min-pairs", type=int, default=2)
    p.add_argument("--holm-family-size", type=int, default=1)
    p.add_argument("--practical-threshold", type=float, default=0.10)
    p.add_argument("--output-dir", required=True)


def _parse_assignments(values: Sequence[str], *, name: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for raw in values:
        key, separator, value = raw.partition("=")
        if not separator or not key.strip() or not value.strip():
            raise ValueError(f"{name} must use HARNESS=VALUE: {raw!r}")
        if key in parsed:
            raise ValueError(f"duplicate {name} for {key}")
        parsed[key] = value
    return parsed


def _parse_aliases(values: Sequence[str]) -> dict[str, frozenset[str]]:
    aliases: dict[str, set[str]] = {}
    for raw in values:
        key, separator, value = raw.partition("=")
        if not separator or not key.strip() or not value.strip():
            raise ValueError(f"provider alias must use HARNESS=PROVIDER_ID: {raw!r}")
        aliases.setdefault(key, set()).add(value)
    return {key: frozenset(value) for key, value in aliases.items()}


def _campaign_hash(value: object) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    import hashlib

    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _isolation_attestation(path_value: str | None) -> tuple[bool, str | None]:
    """Validate the immutable assertion supplied by an external sandbox runner."""
    if path_value is None:
        return False, None
    path = Path(path_value).expanduser().resolve()
    raw = path.read_bytes()
    decoded: Any = json.loads(raw)
    if not isinstance(decoded, dict):
        raise ValueError("isolation attestation must be a JSON object")
    if decoded.get("schema") != "terminus.external-isolation-attestation.v1":
        raise ValueError("isolation attestation has an unsupported schema")
    verifier = decoded.get("verifier")
    if not isinstance(verifier, str) or not verifier.strip() or verifier in {"self", "terminus-eval"}:
        raise ValueError("isolation attestation requires an external verifier identity")
    if decoded.get("verified") is not True:
        raise ValueError("isolation attestation is not verified")
    if decoded.get("isolation_kind") not in {"container", "microvm", "remote_executor"}:
        raise ValueError("isolation attestation has no admitted isolation kind")
    for field in ("runner_digest", "policy_hash"):
        value = decoded.get(field)
        if not isinstance(value, str) or re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None:
            raise ValueError(f"isolation attestation {field} is not an exact digest")
    signature_ref = decoded.get("signature_artifact_ref")
    if (
        not isinstance(signature_ref, str)
        or re.fullmatch(r"artifact://sha256/[0-9a-f]{64}", signature_ref) is None
    ):
        raise ValueError("isolation attestation has no signature artifact reference")
    import hashlib

    return True, "sha256:" + hashlib.sha256(raw).hexdigest()


def _cmd_compare(args: argparse.Namespace) -> int:
    from .runners import (
        CrossHarnessPlan,
        CrossHarnessRunner,
        CrossTaskSpec,
        HarnessSpec,
        OpenCodeCliAdapter,
        PiCliAdapter,
    )
    from .runners.terminus_harness import TerminusHarness

    harness_ids = list(args.harness)
    if len(harness_ids) != len(set(harness_ids)):
        raise ValueError("--harness values must be unique")
    if args.candidate_harness not in harness_ids:
        raise ValueError("--candidate-harness must also appear in --harness")
    pins = _parse_assignments(args.harness_pin, name="harness pin")
    if set(pins) != set(harness_ids):
        raise ValueError("--harness-pin must name every and only selected harness")
    accounts = _parse_assignments(
        args.harness_provider_account,
        name="harness provider account",
    )
    unknown_accounts = set(accounts) - set(harness_ids)
    if unknown_accounts:
        raise ValueError(f"provider accounts name unknown harnesses: {sorted(unknown_accounts)}")
    endpoints = _parse_assignments(args.harness_provider_endpoint, name="harness provider endpoint")
    artifacts = _parse_assignments(args.harness_artifact, name="harness artifact")
    artifact_digests = _parse_assignments(
        args.harness_artifact_digest,
        name="harness artifact digest",
    )
    for label, values in (
        ("provider endpoints", endpoints),
        ("artifacts", artifacts),
        ("artifact digests", artifact_digests),
    ):
        unknown = set(values) - set(harness_ids)
        if unknown:
            raise ValueError(f"{label} name unknown harnesses: {sorted(unknown)}")
    isolation_verified, isolation_attestation_hash = _isolation_attestation(
        args.isolation_attestation
    )
    if args.strict_evidence:
        for label, values in (
            ("provider accounts", accounts),
            ("provider endpoints", endpoints),
            ("artifacts", artifacts),
            ("artifact digests", artifact_digests),
        ):
            if set(values) != set(harness_ids):
                raise ValueError(f"strict evidence requires {label} for every harness")
        if not isolation_verified:
            raise ValueError("strict evidence requires --isolation-attestation")
    elif args.isolation_attestation is not None:
        raise ValueError("--isolation-attestation requires --strict-evidence")
    aliases = _parse_aliases(args.provider_alias)
    unknown_aliases = set(aliases) - set(harness_ids)
    if unknown_aliases:
        raise ValueError(f"provider aliases name unknown harnesses: {sorted(unknown_aliases)}")

    output_dir = Path(args.output_dir).resolve()

    def factory_for(harness_id: str) -> Any:
        if harness_id == "terminus-live":
            return TerminusHarness.from_env()
        if harness_id == "upstream-opencode":
            return OpenCodeCliAdapter(artifact_root=output_dir / "artifacts" / "upstream-opencode")
        if harness_id == "pi":
            return PiCliAdapter(artifact_root=output_dir / "artifacts" / "pi")
        raise ValueError(f"unsupported live harness: {harness_id}")

    harnesses = [
        HarnessSpec(
            harness_id=harness_id,
            harness_commit=pins[harness_id],
            factory=factory_for(harness_id),
            harness_config_hash=_campaign_hash(
                {
                    "harness": harness_id,
                    "provider": args.provider,
                    "model": args.model,
                    "effort": args.effort,
                    "max_steps": args.max_steps,
                    "max_tokens": args.max_tokens,
                    "max_wall_seconds": args.max_wall_seconds,
                }
            ),
            provider_aliases=aliases.get(harness_id, frozenset()),
            pin_verified=True,
            provider_account_id=accounts.get(harness_id),
            provider_endpoint=endpoints.get(harness_id),
            reasoning_effort=args.effort,
            artifact_path=(
                Path(artifacts[harness_id]).expanduser().resolve()
                if harness_id in artifacts
                else None
            ),
            artifact_digest=artifact_digests.get(harness_id),
        )
        for harness_id in harness_ids
    ]
    seeds = list(range(args.seed, args.seed + args.seeds))
    snapshot = ModelCapabilitySnapshot(
        provider=args.provider,
        model=args.model,
        api_version=args.api_version,
        context_window=200_000,
        max_output_tokens=min(args.max_tokens, 128_000),
        supports_tool_calls=True,
        supports_streaming=True,
        supports_cache=True,
    )
    plan = CrossHarnessPlan(
        tasks=[
            CrossTaskSpec(
                suite=args.suite,
                task=args.task,
                task_dir=Path(args.task_dir).resolve(),
                holdout_partition=args.holdout_partition,
            )
        ],
        harnesses=harnesses,
        model_snapshot=snapshot,
        seeds=seeds,
        budgets=Budgets(
            max_tool_calls=args.max_steps,
            max_total_tokens=args.max_tokens,
            max_wall_seconds=args.max_wall_seconds,
        ),
        experiment_assignments=[
            {
                "provider_route": args.provider_route,
                "reasoning_effort": args.effort,
            }
        ],
        output_dir=output_dir,
        require_exact_pins=args.strict_evidence,
        tool_schema_hash=_campaign_hash(
            {"semantic_capabilities": ["read", "write", "edit", "execute"]}
        ),
        isolation_verified=isolation_verified,
        isolation_attestation_hash=isolation_attestation_hash,
    )
    result = CrossHarnessRunner().run(plan)
    reports: list[dict[str, Any]] = []
    for baseline in harness_ids:
        if baseline == args.candidate_harness:
            continue
        evidence = result.derive_paired_evidence(
            baseline,
            args.candidate_harness,
            min_pairs=args.min_pairs,
            require_live=True,
            require_independent_verification=True,
            required_holdout_partition=args.holdout_partition,
            required_tasks=[args.task],
            required_seeds=seeds,
            require_provider_receipts=True,
            holm_family_size=args.holm_family_size,
            practical_improvement_threshold=args.practical_threshold,
        )
        reports.append(evidence.to_dict())
    report = {
        "schema": "terminus.paired-campaign.v1",
        "candidate_harness": args.candidate_harness,
        "harnesses": harness_ids,
        "tasks": [args.task],
        "seeds": seeds,
        "record_count": len(result.records),
        "evidence_mode": "strict" if args.strict_evidence else "local_diagnostic",
        "isolation_attestation_hash": isolation_attestation_hash,
        "eligible": all(bool(item["eligible"]) for item in reports),
        "superiority_demonstrated": all(
            bool(item["eligible"]) and bool(item["significance_passed"]) for item in reports
        ),
        "comparisons": reports,
    }
    _write_json(report, str(output_dir / "report.json"))
    print(
        f"paired campaign completed: records={len(result.records)} "
        f"eligible={report['eligible']} superiority={report['superiority_demonstrated']}"
    )
    return 0 if report["eligible"] else 2


def _live_run_request(args: argparse.Namespace, seed: int) -> RunRequest:
    """Build one live :class:`RunRequest` from the parsed CLI arguments."""
    budgets = Budgets()
    if args.max_steps is not None:
        budgets = replace(budgets, max_tool_calls=int(args.max_steps))
    if args.max_tokens is not None:
        budgets = replace(budgets, max_total_tokens=int(args.max_tokens))
    return RunRequest(
        suite=args.suite,
        task=args.task,
        task_dir=Path(args.task_dir),
        harness_id="terminus-live",
        harness_commit=args.harness_commit,
        model_snapshot=ModelCapabilitySnapshot(
            provider=args.provider,
            model=args.model,
            api_version=os.environ.get("TERMINUS_LIVE_API_VERSION", "2026-08"),
            context_window=200_000,
            max_output_tokens=8_192,
            supports_tool_calls=True,
            supports_streaming=True,
            supports_cache=True,
        ),
        random_seed=seed,
        budgets=budgets,
        reasoning_effort=args.effort,
        provider_account_id=args.provider_account,
    )


def _cmd_run_live(args: argparse.Namespace) -> int:
    """Execute one live evaluation through the Terminus control plane (R8).

    Three suite families are routed here:

    * ``terminal-bench`` / ``harbor`` — delegated to Harbor through the pinned
      adapter, with the Terminus agent shim registered as Harbor's agent.
    * ``swe-bench-pro`` / ``swe-bench*`` — one Terminus turn on a materialised
      instance checkout, then the pinned evaluator (or an honest
      ``evaluation_pending`` with the prediction path).
    * everything else — an internal task package graded by its own declared
      grader.
    """
    from .runners import TrajectoryRecorder
    from .runners.live_runner import (
        LiveRunError,
        materialize_task_workspace,
        run_live_task,
        workspace_diff,
    )
    from .runners.terminus_harness import TerminusControlError, TerminusHarness

    if _is_harbor_suite(args.suite):
        return _cmd_run_harbor(args)

    try:
        harness = TerminusHarness.from_env()
    except TerminusControlError as error:
        print(f"live run unavailable: {error}", file=sys.stderr)
        return 2

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for i in range(args.seeds):
        seed = args.seed + i
        request = _live_run_request(args, seed)
        recorder = TrajectoryRecorder(run_id=f"{args.suite}-{args.task}-{seed}")

        if _is_swebench_pro_suite(args.suite):
            record = _run_swebench_pro_seed(args, harness, request, recorder, seed)
        else:
            package_dir = Path(args.task_dir)
            try:
                materialized = materialize_task_workspace(
                    package_dir,
                    _internal_workspace(args, seed),
                    run_setup=not args.no_setup,
                )
            except LiveRunError as error:
                print(f"live run unavailable: {error}", file=sys.stderr)
                return 2
            # The agent is pointed at the scratch tree; the package (grader,
            # hidden tests, acceptance criteria, task.yaml identity) stays
            # outside anything the model may edit.
            run_request = replace(
                request,
                task_dir=materialized.workspace,
                task_package_dir=package_dir,
            )
            result, patch_payload = run_live_task(harness, run_request, recorder)
            if not patch_payload.get("diff") and materialized.base_commit:
                # The control plane returned nothing; the workspace is a git
                # repository now, so the diff is still recoverable locally.
                local = workspace_diff(materialized.workspace, materialized.base_commit)
                if local:
                    patch_payload = {**patch_payload, "diff": local, "diff_source": "local_git"}
            record = build_live_run_record(
                harness_result=result,
                request=run_request,
                patch_payload=patch_payload,
                seed=seed,
                task_package_dir=package_dir,
                workspace=materialized.workspace,
                workspace_base_commit=materialized.base_commit,
                grader_assets_dir=materialized.grader_assets_dir,
                trajectory=recorder.to_dicts(),
            )
            record.artifacts.append({"kind": "task_workspace", **materialized.to_dict()})
        _write_record(record, output_dir, args.format)
        n += 1
        print(
            f"  run {n}/{args.seeds}: {record.run_id} outcome={record.outcome.value} "
            f"success={record.success} steps={record.steps} "
            f"cost_usd={record.cost.computed_usd if record.cost else 'unknown'}"
        )
    print(f"live runs completed: {n}")
    return 0


def _internal_workspace(args: argparse.Namespace, seed: int) -> Path:
    """Where this seed's scratch workspace lives."""
    if args.workspace:
        return Path(str(args.workspace))
    safe_task = str(args.task).replace("/", "__")
    return Path(str(args.output_dir)) / "workspaces" / str(args.suite) / safe_task / str(seed)


def _is_harbor_suite(suite: str) -> bool:
    """Whether a suite id routes to the Harbor / Terminal-Bench adapter."""
    normalized = suite.strip().lower()
    return normalized in {"terminal-bench", "harbor"} or normalized.startswith("terminal-bench")


def _is_swebench_pro_suite(suite: str) -> bool:
    normalized = suite.strip().lower()
    return normalized in {"swe-bench-pro", "swebench-pro"} or normalized.startswith("swe-bench-pro")


def _suite_manifest_path(suite: str) -> Path:
    """Locate a suite manifest relative to the repository root."""
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / "evals" / "suites" / f"{suite}.yaml"


def _cmd_run_harbor(args: argparse.Namespace) -> int:
    """Run Terminal-Bench through Harbor with the Terminus agent shim."""
    from .runners.harbor_agent import TERMINUS_HARBOR_AGENT_IMPORT_PATH, harbor_agent_env
    from .runners.harbor_runner import HarborUnavailable, run_harbor_tasks

    manifest_path = _suite_manifest_path("terminal-bench")
    if not manifest_path.exists():
        print(f"error: suite manifest not found: {manifest_path}", file=sys.stderr)
        return 1
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    try:
        env = harbor_agent_env()
    except RuntimeError as error:
        print(f"live run unavailable: {error}", file=sys.stderr)
        return 2

    n = 0
    for i in range(args.seeds):
        seed = args.seed + i
        request = _live_run_request(args, seed)
        try:
            record = run_harbor_tasks(
                manifest_path=manifest_path,
                request=request,
                seed=seed,
                agent_import_path=TERMINUS_HARBOR_AGENT_IMPORT_PATH,
                agent_env=env,
                jobs_dir=output_dir / "harbor-jobs",
            )
        except HarborUnavailable as error:
            print(f"harbor run unavailable: {error}", file=sys.stderr)
            return 2
        _write_record(record, output_dir, args.format)
        n += 1
        print(f"  harbor run {n}/{args.seeds}: {record.run_id} outcome={record.outcome.value}")
    print(f"live runs completed: {n}")
    return 0


def _run_swebench_pro_seed(
    args: argparse.Namespace,
    harness: Any,
    request: RunRequest,
    recorder: Any,
    seed: int,
) -> RunRecord:
    """Run one SWE-bench Pro instance end to end and record the outcome."""
    from .runners.swebench_pro import (
        SweBenchProError,
        evaluate_prediction,
        grader_result_for_report,
        load_instance,
        materialize_instance,
        write_prediction_files,
    )

    manifest_path = _suite_manifest_path("swe-bench-pro")
    instance = load_instance(
        args.task,
        instance_file=Path(args.instance_file) if args.instance_file else None,
    )
    workspace = Path(args.task_dir)
    materialization = materialize_instance(instance, workspace)
    # The issue text is the instruction; SWE-bench Pro ships no prompt.md and
    # writing one into the checkout would show up in the extracted patch.
    request = replace(request, task_dir=workspace, instruction=instance.instruction())
    from .runners.live_runner import run_live_task

    result, patch_payload = run_live_task(harness, request, recorder)
    diff = str(patch_payload.get("diff") or "")
    if not diff.strip():
        diff = materialization.local_diff()
    prediction = write_prediction_files(
        instance_id=instance.instance_id,
        model_name_or_path=f"terminus-live/{request.model_snapshot.model}",
        model_patch=diff,
        output_dir=Path(args.output_dir) / "predictions",
    )
    try:
        evaluation = evaluate_prediction(prediction, manifest_path=manifest_path)
    except SweBenchProError as error:
        evaluation = {"status": "evaluator_error", "error": str(error)}
    record = build_live_run_record(
        harness_result=result,
        request=request,
        patch_payload=patch_payload,
        seed=seed,
        workspace=workspace,
        # The instance's own base commit: every diff in the prediction is
        # taken against it, exactly as the evaluator expects.
        workspace_base_commit=materialization.base_commit,
        trajectory=recorder.to_dicts(),
        external_evaluation=evaluation,
    )
    # The verdict for an external benchmark belongs to the external evaluator,
    # not to an internal task grader the instance does not ship.
    record.grader_results = [grader_result_for_report(evaluation)]
    record.artifacts.append(
        {
            "kind": "swebench_pro_prediction",
            "instance_id": instance.instance_id,
            "predictions_path": str(prediction.predictions_path),
            "patches_path": str(prediction.patches_path),
            "base_commit": instance.base_commit,
            "repo": instance.repo,
            # The dataset publishes a per-instance image *tag*, not a digest,
            # so the suite's per_instance_required policy is not satisfied by
            # it; the gap is recorded rather than papered over.
            "image_reference": instance.image_reference,
            "image_digest_status": "tag_only",
            "materialization": materialization.to_dict(),
        }
    )
    return record


def build_live_run_record(
    harness_result: HarnessResult,
    request: RunRequest,
    patch_payload: dict[str, Any],
    seed: int,
    *,
    task_package_dir: Path | None = None,
    workspace: Path | None = None,
    workspace_base_commit: str | None = None,
    grader_assets_dir: Path | None = None,
    trajectory: list[dict[str, Any]] | None = None,
    external_evaluation: dict[str, Any] | None = None,
) -> RunRecord:
    """Compose one honest RunRecord from a live harness result.

    ``success`` comes from the task's **declared grader**, executed here
    against the post-run workspace. The control plane's own verification
    conclusion is recorded separately as ``harness_verdict`` so a
    false-positive completion is visible rather than scored as a pass.
    """
    from .runners.harness_runner import apply_metrics_to_record
    from .runners.task_graders import load_task_grader_spec, run_task_grader

    notes = json.loads(harness_result.notes) if harness_result.notes else {}
    metrics = dict(getattr(harness_result, "metrics", {}) or {})
    outcome = (
        harness_result.outcome
        if isinstance(harness_result.outcome, Outcome)
        else Outcome(str(harness_result.outcome).split(".")[-1])
    )
    artifacts = list(harness_result.artifacts)
    if patch_payload.get("diff"):
        artifacts.append(
            {
                "kind": "workspace_patch",
                "diff_chars": len(patch_payload["diff"]),
                "truncated": bool(patch_payload.get("truncated")),
            }
        )

    # The environment digest is the harness's content-addressed digest of the
    # fixture tree plus the control plane's stable identity. It is never a
    # session label: `evals/registry.yaml` requires a real content digest and
    # the local exit gate rejects anything that is not `sha256:<64 hex>`.
    environment_digest = harness_result.environment_digest or _fallback_environment_digest(request)

    # The grader, the hidden tests and `task.yaml` live in the task *package*;
    # the agent only ever edits the workspace. When they are the same directory
    # this collapses to the pre-existing in-place behaviour.
    package_dir = task_package_dir or request.task_package_dir or request.task_dir
    grader_spec = load_task_grader_spec(package_dir)
    grade_workspace = workspace or request.task_dir
    grader_results = [
        run_task_grader(
            package_dir,
            grade_workspace,
            objective=f"{request.suite}/{request.task}",
            spec=grader_spec,
            grader_assets_dir=grader_assets_dir,
        )
    ]

    resolved_model_snapshot = {
        **request.model_snapshot.to_dict(),
        **(metrics.get("model_snapshot") or {}),
        "steering": metrics.get("steering", {}),
    }

    record = RunRecord(
        run_id=f"live-{request.suite}-{request.task}-{seed}-{uuid.uuid4().hex[:8]}",
        suite=request.suite,
        task=request.task,
        harness=request.harness_id,
        harness_commit=request.harness_commit,
        # The harness's live snapshot wins over the caller's guess: `--provider`
        # defaults to a placeholder, and "fake" must never describe a real run.
        model_capability_snapshot=resolved_model_snapshot,
        environment_digest=environment_digest,
        random_seed=seed,
        budgets=request.budgets.to_dict(),
        experiment_assignments=list(request.experiment_assignments),
        outcome=outcome,
        grader_results=grader_results,
        cost=harness_result.cost,
        artifacts=artifacts,
        context_manifests=list(getattr(harness_result, "context_manifests", []) or []),
        trajectory=list(trajectory or []),
        evidence_class=harness_result.evidence_class,
        provider_receipts=list(harness_result.provider_receipts),
        notes=json.dumps(
            {
                **notes,
                "mode": "live",
                "token_source": metrics.get("token_source", "unavailable"),
                "grader": grader_spec.grader_id,
                "evaluation": (
                    external_evaluation
                    if external_evaluation is not None
                    else ("graded" if grader_spec.available else "no_task_grader")
                ),
            },
            sort_keys=True,
        ),
        evaluation_identity=build_evaluation_identity(
            request,
            environment_digest=environment_digest,
            model_snapshot=resolved_model_snapshot,
        ),
    )
    apply_metrics_to_record(record, metrics)
    record.attempts = list(metrics.get("attempts") or [])
    record.workspace_base_commit = workspace_base_commit
    # The record is composed after the run, so `start` is back-dated from the
    # measured wall clock rather than left at "when we wrote the file".
    ended = record.start
    record.end = ended
    if record.wall_clock_ms is not None:
        record.start = ended - timedelta(milliseconds=record.wall_clock_ms)
    return record


def _fallback_environment_digest(request: RunRequest) -> str:
    """Content-address the task tree when the harness returned no digest."""
    from .runners.environment_digest import LiveEnvironmentDigest

    return LiveEnvironmentDigest.build(
        workspace_root=request.task_dir,
        task_dir=request.task_package_dir or request.task_dir,
    ).to_digest()


def _cmd_run(args: argparse.Namespace) -> int:
    """Execute the ``run`` command."""
    # R8/Cubic: explicit harness selection wins; TERMINUS_CONTROL_URL alone
    # only implies live mode when fixture mode was NOT requested.
    if args.fixture_mode and args.harness in {"terminus-live", "terminus"}:
        print(
            "--fixture-mode cannot override --harness terminus-live; drop one",
            file=sys.stderr,
        )
        return 2
    live_requested = args.harness in {"terminus-live", "terminus"} or (
        bool(os.environ.get("TERMINUS_CONTROL_URL")) and not args.fixture_mode
    )
    if live_requested:
        return _cmd_run_live(args)

    if not args.fixture_mode:
        print(
            "run requires either --fixture-mode (deterministic test data) or a live "
            "target: --harness terminus-live with TERMINUS_CONTROL_URL set",
            file=sys.stderr,
        )
        return 2

    selection = select_harness(args.harness, fixture_mode=True)
    harness_runner = HarnessRunner(harness=FakeScriptHarness(result=_fake_result(args)))
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    n = 0
    for i in range(args.seeds):
        seed = args.seed + i
        request = RunRequest(
            suite=args.suite,
            task=args.task,
            task_dir=Path(args.task_dir),
            harness_id=selection.harness_id,
            harness_commit=args.harness_commit,
            model_snapshot=ModelCapabilitySnapshot(
                provider=args.provider,
                model=args.model,
                api_version="v1",
                context_window=128000,
                max_output_tokens=8192,
                supports_tool_calls=True,
                supports_streaming=True,
                supports_cache=True,
                pricing={"input": 3.0, "output": 15.0},
            ),
            random_seed=seed,
            budgets=Budgets(),
        )
        record = harness_runner.run(request)
        _write_record(record, output_dir, args.format, suffix=f"-{seed}")
        n += 1
        print(f"  run {n}/{args.seeds}: {record.run_id} outcome={record.outcome.value}")
    print(f"wrote {n} run(s) to {output_dir}")
    return 0


def _fake_result(args: argparse.Namespace) -> HarnessResult:
    """Build a fake successful harness result for the demo CLI."""
    cost = make_default_cost(
        {"input_tokens": 1000, "output_tokens": 500},
        {"input": 3.0, "output": 15.0},
    )
    return HarnessResult(
        outcome=Outcome.COMPLETED,
        final_revision="deadbeef",
        cost=cost,
        artifacts=[],
        context_manifests=[],
        grader_outcomes=[
            GraderOutcome(
                grader_id="end_state.noop",
                grader_version="0.1.0",
                passed=True,
                score=1.0,
                evidence=["noop grader (demo)"],
            )
        ],
        notes="fixture-only scripted harness; not live or release evidence",
    )


def _write_record(record: RunRecord, output_dir: Path, fmt: str, *, suffix: str = "") -> None:
    """Write a run record to ``output_dir`` in the requested format."""
    if fmt == "json":
        record.to_json(output_dir / f"run-{record.run_id}{suffix}.json")
    elif fmt == "parquet":
        record.to_parquet(output_dir / f"run-{record.run_id}{suffix}.parquet")
    else:  # jsonl
        with (output_dir / "runs.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(record.to_jsonl_line() + "\n")


# ──────────────────────────── aggregate ───────────────────────────────────


def _add_aggregate_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    """Add the ``aggregate`` command."""
    p = sub.add_parser("aggregate", help="Aggregate run records into cohort summaries.")
    p.add_argument(
        "--runs-dir", default="evals/results", help="Directory of JSON/JSONL run records."
    )
    p.add_argument("--output", default="-", help="Output path ('-' for stdout).")
    p.add_argument(
        "--format",
        choices=["csv", "json", "parquet"],
        default="csv",
        help="Output format.",
    )


def _cmd_aggregate(args: argparse.Namespace) -> int:
    """Execute the ``aggregate`` command."""
    catalog = _load_runs_dir(args.runs_dir)
    if catalog.n == 0:
        print(f"no runs found in {args.runs_dir}", file=sys.stderr)
        return 2
    df = summarize_runs(catalog)
    _write_df(df, args.output, args.format)
    return 0


def _write_df(df: Any, output: str, fmt: str) -> None:
    """Write a Polars DataFrame to ``output`` in the requested format."""
    if output == "-":
        if fmt == "csv":
            sys.stdout.write(df.write_csv())
        elif fmt == "json":
            sys.stdout.write(df.write_json())
        else:
            sys.stdout.write(df.write_json())
        return
    p = Path(output)
    p.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "csv":
        df.write_csv(p)
    elif fmt == "json":
        df.write_json(p)
    else:
        df.write_parquet(p)


# ──────────────────────────── dashboard ───────────────────────────────────


def _add_dashboard_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    """Add the ``dashboard`` command."""
    p = sub.add_parser("dashboard", help="Generate a cohort dashboard HTML.")
    p.add_argument("--runs-dir", default="evals/results", help="Directory of run records.")
    p.add_argument("--cohort", default=None, help="Filter to a single cohort id.")
    p.add_argument("--output", required=True, help="Output HTML path.")
    p.add_argument("--baseline-harness", default=None, help="Highlight this harness as baseline.")
    p.add_argument("--title", default=None, help="Dashboard title.")


def _cmd_dashboard(args: argparse.Namespace) -> int:
    """Execute the ``dashboard`` command."""
    catalog = _load_runs_dir(args.runs_dir)
    if catalog.n == 0:
        print(f"no runs found in {args.runs_dir}", file=sys.stderr)
        return 2
    records = catalog.records
    if args.cohort:
        # Cohort is stored as the `suite` field on each record.
        records = [r for r in records if r.suite == args.cohort]
        if not records:
            print(f"no runs for cohort {args.cohort}", file=sys.stderr)
            return 2
    write_cohort_dashboard(
        records,
        args.output,
        title=args.title or "Terminus Eval Lab — Cohort Dashboard",
        baseline_harness=args.baseline_harness,
    )
    print(f"wrote {args.output}")
    return 0


# ──────────────────────────── promote ─────────────────────────────────────


def _add_promote_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    """Add the ``promote`` command."""
    p = sub.add_parser("promote", help="Evaluate the promotion gate for an experiment.")
    p.add_argument("--experiment", required=True, help="Experiment id (for logging).")
    p.add_argument(
        "--decision",
        choices=["promote", "retain", "rollback"],
        required=True,
        help="Proposed decision (the gate may override).",
    )
    p.add_argument("--evaluation-json", required=True, help="Path to an Evaluation JSON file.")
    p.add_argument(
        "--change-manifest", default=None, help="Optional change manifest YAML to update."
    )
    p.add_argument("--output", default="-", help="Output path for the gate result JSON.")


def _cmd_promote(args: argparse.Namespace) -> int:
    """Execute the ``promote`` command."""
    ev = _load_evaluation(args.evaluation_json)
    result = evaluate_promotion(ev)
    # The proposed decision is informational; the gate's verdict is authoritative.
    out = {
        "experiment": args.experiment,
        "proposed_decision": args.decision,
        "gate_decision": result.decision.value,
        "gate_reason": result.reason,
        "gates": [
            {
                "name": g.name,
                "status": g.status.value,
                "detail": g.detail,
                "evidence": dict(g.evidence),
            }
            for g in result.gates
        ],
        "passed": result.passed,
    }
    if args.change_manifest:
        _update_change_manifest(args.change_manifest, result)
    _write_json(out, args.output)
    print(f"gate decision: {result.decision.value} (proposed: {args.decision}) — {result.reason}")
    return 0  # Exit 0; the gate verdict is in the JSON.


def _load_evaluation(path: str) -> Evaluation:
    """Load an :class:`Evaluation` from a JSON file."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return Evaluation(**data)


def _update_change_manifest(path: str, result: PromotionGateResult) -> None:
    """Update a change manifest YAML with the gate's decision."""
    p = Path(path)
    if not p.exists():
        return
    manifest = ChangeManifest.from_yaml(p)
    decision_map = {
        PromotionDecision.PROMOTE: Decision.PROMOTE,
        PromotionDecision.RETAIN_EXPERIMENTAL: Decision.RETAIN_EXPERIMENTAL,
        PromotionDecision.REVISE: Decision.REVISE,
        PromotionDecision.ROLLBACK: Decision.ROLLBACK,
    }
    manifest.make_decision(decision_map[result.decision], reason=result.reason)
    manifest.to_yaml_file(p)


def _write_json(obj: Any, output: str) -> None:
    """Write a JSON-serializable object to ``output`` ('-' for stdout)."""
    text = json.dumps(obj, indent=2, sort_keys=True, default=str)
    if output == "-":
        sys.stdout.write(text + "\n")
        return
    p = Path(output)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


# ──────────────────────────── regression ─────────────────────────────────


def _add_regression_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    """Add the ``regression`` command."""
    p = sub.add_parser("regression", help="Compare two run sets for regressions.")
    p.add_argument("--baseline-run", required=True, help="Baseline runs (JSONL/JSON dir/Parquet).")
    p.add_argument(
        "--candidate-run", required=True, help="Candidate runs (JSONL/JSON dir/Parquet)."
    )
    p.add_argument("--baseline-label", default="baseline", help="Label for the baseline.")
    p.add_argument("--candidate-label", default="candidate", help="Label for the candidate.")
    p.add_argument("--margin", type=float, default=0.05, help="Non-inferiority margin.")
    p.add_argument("--output", default="-", help="Output JSON path ('-' for stdout).")


def _cmd_regression(args: argparse.Namespace) -> int:
    """Execute the ``regression`` command."""
    baseline = _load_runs(args.baseline_run)
    candidate = _load_runs(args.candidate_run)
    if baseline.n == 0 or candidate.n == 0:
        print("empty run set(s)", file=sys.stderr)
        return 2
    report = detect_regressions(
        baseline,
        candidate,
        baseline_label=args.baseline_label,
        candidate_label=args.candidate_label,
        noninferiority_margin=args.margin,
    )
    _write_json(report.to_dict(), args.output)
    regressed = report.regressed_cohorts
    improved = report.improved_cohorts
    print(
        f"regressed: {regressed or '[]'} | improved: {improved or '[]'} | "
        f"cohorts: {len(report.cohort_results)}"
    )
    return 1 if regressed else 0


# ──────────────────────────── security ────────────────────────────────────


def _add_security_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    """Add the ``security`` command."""
    p = sub.add_parser("security", help="Generate a security report from run records.")
    p.add_argument("--runs-dir", required=True, help="Directory of run records.")
    p.add_argument("--output", required=True, help="Output HTML path.")


def _cmd_security(args: argparse.Namespace) -> int:
    """Execute the ``security`` command."""
    catalog = _load_runs_dir(args.runs_dir)
    if catalog.n == 0:
        print(f"no runs found in {args.runs_dir}", file=sys.stderr)
        return 2
    report = compute_security_report(catalog.records)
    write_security_report(report, args.output)
    verdict = "PASS" if report.overall_passed else "FAIL"
    print(f"security verdict: {verdict} ({len(report.blocking_failures)} blocking)")
    return 0 if report.overall_passed else 1


# ──────────────────────────── dispatch + helpers ──────────────────────────


def _dispatch(args: argparse.Namespace) -> int:
    """Dispatch to the right subcommand handler."""
    handlers = {
        "run": _cmd_run,
        "compare": _cmd_compare,
        "bench-check": _cmd_bench_check,
        "aggregate": _cmd_aggregate,
        "dashboard": _cmd_dashboard,
        "promote": _cmd_promote,
        "regression": _cmd_regression,
        "security": _cmd_security,
        "tier": _cmd_tier,
        "exit-gate": _cmd_exit_gate,
        "conformance": _cmd_conformance,
    }
    handler = handlers.get(args.command)
    if handler is None:
        print(f"unknown command: {args.command}", file=sys.stderr)
        return 1
    return handler(args)


def _add_bench_check_cmd(sub: argparse._SubParsersAction[Any]) -> None:
    p = sub.add_parser(
        "bench-check",
        help="Validate external benchmark suite manifests through their adapters.",
    )
    p.add_argument(
        "--suites-dir",
        default="evals/suites",
        help="Directory containing suite YAML manifests.",
    )
    p.add_argument(
        "--suite",
        action="append",
        dest="suites",
        help="Validate only these manifest files (repeatable; defaults to all).",
    )


def _cmd_bench_check(args: argparse.Namespace) -> int:
    """Validate every declared external benchmark suite through its adapter.

    Offline gate for the audit P0-5 requirement that benchmark manifests are
    not merely declared but provably translatable at HEAD. A live run still
    requires a kernel-brokered harness and credentials; this command proves
    the manifests, pins, and task filters parse and agree.
    """
    from .runners.benchmark_adapters import (
        BenchmarkManifestError,
        load_benchmark_manifest,
    )

    suites_dir = Path(args.suites_dir)
    if not suites_dir.is_dir():
        print(f"error: suites directory does not exist: {suites_dir}", file=sys.stderr)
        return 1
    files = (
        [Path(name) for name in args.suites] if args.suites else sorted(suites_dir.glob("*.yaml"))
    )
    if not files:
        print(f"no suite manifests found in {suites_dir}", file=sys.stderr)
        return 1

    failures = 0
    checked = 0
    skipped = 0
    for path in files:
        full = path
        if not full.is_absolute() and not full.exists():
            full = suites_dir / path
        try:
            raw = __import__("yaml").safe_load(full.read_text(encoding="utf-8"))
            suite_block = raw.get("suite") if isinstance(raw, dict) else None
            has_adapter = isinstance(suite_block, dict) and isinstance(
                suite_block.get("adapter"), dict
            )
            if not has_adapter:
                print(f"[bench-check] skip {full.name}: no external benchmark adapter section")
                skipped += 1
                continue
            manifest = load_benchmark_manifest(full)
            checked += 1
            print(
                f"[bench-check] ok   {full.name}: {manifest.suite_id} kind={manifest.adapter_kind} "
                f"tasks={manifest.task_count} harness_commit={manifest.harness_commit[:12]}"
            )
        except (BenchmarkManifestError, OSError, ValueError) as exc:
            failures += 1
            print(f"[bench-check] FAIL {full.name}: {exc}", file=sys.stderr)
    print(f"[bench-check] {checked} validated, {skipped} skipped, {failures} failed")
    return 1 if failures else 0


def _load_runs(path: str) -> RunCatalog:
    """Load a run catalog from a JSONL, JSON dir, or Parquet file."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"no such file or directory: {path}")
    if p.is_dir():
        return _load_runs_dir(path)
    if p.suffix == ".parquet":
        return load_runs_from_parquet(p)
    if p.suffix == ".jsonl":
        return load_runs_from_jsonl(p)
    # Single JSON file?
    if p.suffix == ".json":
        return RunCatalog(records=[RunRecord.from_json(p)])
    raise ValueError(f"unrecognized run path: {path}")


def _load_runs_dir(dir_path: str) -> RunCatalog:
    """Load all run records from a directory.

    Looks for ``runs.jsonl`` first, then for individual ``*.json`` files.
    """
    d = Path(dir_path)
    if not d.exists():
        return RunCatalog()
    jsonl = d / "runs.jsonl"
    if jsonl.exists():
        return load_runs_from_jsonl(jsonl)
    parquet = d / "runs.parquet"
    if parquet.exists():
        return load_runs_from_parquet(parquet)
    return load_runs_from_json_dir(d, pattern="*.json")


if __name__ == "__main__":
    sys.exit(main())
