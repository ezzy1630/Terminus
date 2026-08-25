"""SPEC §41 / §43.7 ``terminus-eval`` command-line interface.

Built with :mod:`argparse` (no Click/Typer dependency, keeping the install
footprint small). Provides commands for the standard eval workflow:

- ``terminus-eval run`` — run a single harness on a task.
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
from datetime import datetime
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
    make_default_cost,
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
        "--fixture-mode",
        action="store_true",
        help="Explicitly run the deterministic fake harness; output is never release evidence.",
    )
    p.add_argument("--output-dir", default="evals/results", help="Directory to write run records.")
    p.add_argument(
        "--format",
        choices=["json", "jsonl", "parquet"],
        default="jsonl",
        help="Output format for run records.",
    )


def _cmd_run_live(args: argparse.Namespace) -> int:
    """Execute one live evaluation through the Terminus control plane (R8)."""
    from .runners import TrajectoryRecorder
    from .runners.live_runner import run_live_task
    from .runners.terminus_harness import TerminusControlError, TerminusHarness

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
        request = RunRequest(
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
        )
        recorder = TrajectoryRecorder(run_id=f"{args.suite}-{args.task}-{seed}")
        result, patch_payload = run_live_task(harness, request, recorder)
        record = build_live_run_record(
            harness_result=result,
            request=request,
            patch_payload=patch_payload,
            seed=seed,
        )
        _write_record(record, output_dir, args.format)
        n += 1
    print(f"live runs completed: {n}")
    return 0


def build_live_run_record(
    harness_result: HarnessResult,
    request: RunRequest,
    patch_payload: dict[str, Any],
    seed: int,
) -> RunRecord:
    """Compose one honest RunRecord from a live harness result.

    Grader results stay empty until an external grader or the control plane's
    verification evidence is reconciled; completion alone is never recorded as
    success (anti-gaming rule).
    """
    notes = json.loads(harness_result.notes) if harness_result.notes else {}
    usage = notes.get("provider_usage") or {}
    outcome = harness_result.outcome if isinstance(harness_result.outcome, Outcome) else Outcome(
        str(harness_result.outcome).split(".")[-1]
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
    return RunRecord(
        run_id=f"live-{request.suite}-{request.task}-{seed}-{uuid.uuid4().hex[:8]}",
        suite=request.suite,
        task=request.task,
        harness=request.harness_id,
        harness_commit=request.harness_commit,
        model_capability_snapshot={
            "provider": request.model_snapshot.provider,
            "model": request.model_snapshot.model,
        },
        environment_digest=f"remote:{notes.get('workspace_id', 'unknown')}",
        random_seed=seed,
        budgets={},
        experiment_assignments=[],
        outcome=outcome,
        grader_results=[],
        cost=None,
        artifacts=artifacts,
        context_manifests=list(getattr(harness_result, "context_manifests", []) or []),
        notes=json.dumps(
            {
                **notes,
                "mode": "live",
                "input_tokens": int(usage.get("input_tokens", 0)),
                "output_tokens": int(usage.get("output_tokens", 0)),
                "cached_tokens": int(usage.get("cached_tokens", 0)),
                "evaluation": ("pending_grader" if patch_payload.get("diff") else "no_patch"),
            },
            sort_keys=True,
        ),
    )


def _cmd_run(args: argparse.Namespace) -> int:
    """Execute the ``run`` command."""
    live_requested = args.harness in {"terminus-live", "terminus"} or (
        os.environ.get("TERMINUS_CONTROL_URL") and not args.fixture_mode
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
            harness_id=args.harness,
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
    files = [Path(name) for name in args.suites] if args.suites else sorted(suites_dir.glob("*.yaml"))
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
            has_adapter = isinstance(suite_block, dict) and isinstance(suite_block.get("adapter"), dict)
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
