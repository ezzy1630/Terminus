"""SWE-bench Pro: instance materialisation, predictions, and honest grading states."""

from __future__ import annotations

import json
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from forge_evals.runners.swebench_pro import (
    SWE_BENCH_PRO_DATASET,
    SWE_BENCH_PRO_HARNESS_COMMIT,
    SWE_BENCH_PRO_REVISION,
    SweBenchProError,
    SweBenchProInstance,
    evaluate_prediction,
    grader_result_for_report,
    load_instance,
    materialize_instance,
    read_evaluation_report,
    write_prediction_files,
)

pytestmark = pytest.mark.skipif(shutil.which("git") is None, reason="git is required")


def _git(repo: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    )
    return completed.stdout.strip()


def _source_repo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "repos" / "acme__widget"
    repo.mkdir(parents=True)
    subprocess.run(["git", "-C", str(repo), "init", "-q", "-b", "main"], check=True)
    _git(repo, "config", "user.email", "eval@example.com")
    _git(repo, "config", "user.name", "eval")
    (repo / "widget.py").write_text("def add(a, b):\n    return a - b\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "initial")
    base = _git(repo, "rev-parse", "HEAD")
    # A later commit proves the materialisation checks out the *base* commit.
    (repo / "widget.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "later")
    return repo, base


def _instance_file(tmp_path: Path, base_commit: str) -> Path:
    path = tmp_path / "instances.jsonl"
    path.write_text(
        json.dumps(
            {
                "instance_id": "acme__widget-1234",
                "repo": "acme__widget",
                "base_commit": base_commit,
                "problem_statement": "add() subtracts instead of adding.",
                "requirements": "add(2, 3) must return 5.",
                "repo_language": "python",
                "fail_to_pass": "['tests/test_widget.py::test_add']",
                "dockerhub_tag": "acme_widget_1234",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return path


# ──────────────────────────── instance loading ────────────────────────────


def test_load_instance_from_a_pinned_local_file(tmp_path: Path) -> None:
    _, base = _source_repo(tmp_path)
    instance = load_instance("acme__widget-1234", instance_file=_instance_file(tmp_path, base))
    assert instance.repo == "acme__widget"
    assert instance.base_commit == base
    assert instance.image_reference == "jefzda/sweap-images:acme_widget_1234"
    assert "add() subtracts" in instance.instruction()
    assert "must return 5" in instance.instruction()


def test_unknown_instance_is_an_error_not_an_empty_run(tmp_path: Path) -> None:
    _, base = _source_repo(tmp_path)
    with pytest.raises(SweBenchProError, match="is not in"):
        load_instance("nope", instance_file=_instance_file(tmp_path, base))


def test_incomplete_instance_records_are_rejected() -> None:
    with pytest.raises(SweBenchProError, match="base_commit"):
        SweBenchProInstance.from_mapping(
            {"instance_id": "x", "repo": "a/b", "problem_statement": "s"}
        )


def test_pins_match_the_suite_manifest() -> None:
    import yaml

    repo_root = Path(__file__).resolve().parents[4]
    manifest = yaml.safe_load(
        (repo_root / "evals" / "suites" / "swe-bench-pro.yaml").read_text(encoding="utf-8")
    )
    adapter = manifest["suite"]["adapter"]
    assert adapter["dataset"] == SWE_BENCH_PRO_DATASET
    assert adapter["revision"] == SWE_BENCH_PRO_REVISION
    assert adapter["harness"]["commit"] == SWE_BENCH_PRO_HARNESS_COMMIT


# ──────────────────────────── materialisation ─────────────────────────────


def test_materialize_checks_out_the_base_commit(tmp_path: Path) -> None:
    source, base = _source_repo(tmp_path)
    instance = load_instance("acme__widget-1234", instance_file=_instance_file(tmp_path, base))
    workspace = tmp_path / "workspace"

    materialization = materialize_instance(
        instance, workspace, repo_url_template=str(source.parent / "{repo}")
    )

    assert materialization.head_revision == base
    # The base commit still has the bug; the fix commit must not be present.
    assert (workspace / "widget.py").read_text(encoding="utf-8") == "def add(a, b):\n    return a - b\n"


def test_local_diff_is_the_fallback_patch_source(tmp_path: Path) -> None:
    source, base = _source_repo(tmp_path)
    instance = load_instance("acme__widget-1234", instance_file=_instance_file(tmp_path, base))
    workspace = tmp_path / "workspace"
    materialization = materialize_instance(
        instance, workspace, repo_url_template=str(source.parent / "{repo}")
    )

    (workspace / "widget.py").write_text("def add(a, b):\n    return a + b\n", encoding="utf-8")
    (workspace / "NEW.md").write_text("notes\n", encoding="utf-8")
    diff = materialization.local_diff()

    assert "widget.py" in diff
    assert "+    return a + b" in diff
    assert "NEW.md" in diff, "untracked work must not be silently dropped"


def test_materialize_refuses_to_overwrite_unrelated_files(tmp_path: Path) -> None:
    source, base = _source_repo(tmp_path)
    instance = load_instance("acme__widget-1234", instance_file=_instance_file(tmp_path, base))
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "important.txt").write_text("do not clobber", encoding="utf-8")

    with pytest.raises(SweBenchProError, match="not empty"):
        materialize_instance(instance, workspace, repo_url_template=str(source.parent / "{repo}"))


def test_materialize_refuses_to_reuse_a_checkout_from_another_repository(tmp_path: Path) -> None:
    source, base = _source_repo(tmp_path)
    other = tmp_path / "repos" / "other__widget"
    other.mkdir(parents=True)
    subprocess.run(["git", "-C", str(other), "init", "-q", "-b", "main"], check=True)
    _git(other, "config", "user.email", "eval@example.com")
    _git(other, "config", "user.name", "eval")
    (other / "other.py").write_text("value = 1\n", encoding="utf-8")
    _git(other, "add", "-A")
    _git(other, "commit", "-q", "-m", "initial")
    other_base = _git(other, "rev-parse", "HEAD")

    instance = SweBenchProInstance(
        instance_id="other__widget-1234",
        repo="other__widget",
        base_commit=other_base,
        problem_statement="change the value",
    )
    workspace = tmp_path / "workspace"
    materialize_instance(instance, workspace, repo_url_template=str(source.parent / "{repo}"))

    with pytest.raises(SweBenchProError, match="unrelated repository"):
        materialize_instance(
            SweBenchProInstance(
                instance_id="acme__widget-1234",
                repo="acme__widget",
                base_commit=base,
                problem_statement="fix add",
            ),
            workspace,
            repo_url_template=str(source.parent / "{repo}"),
        )


# ──────────────────────────── predictions ─────────────────────────────────


def test_both_prediction_formats_are_written(tmp_path: Path) -> None:
    prediction = write_prediction_files(
        instance_id="acme__widget-1234",
        model_name_or_path="terminus-live/gpt-5.6",
        model_patch="diff --git a/widget.py b/widget.py\n",
        output_dir=tmp_path / "predictions",
    )

    # The canonical SWE-bench prediction shape.
    swebench = json.loads(prediction.predictions_path.read_text(encoding="utf-8"))
    assert swebench == [
        {
            "instance_id": "acme__widget-1234",
            "model_name_or_path": "terminus-live/gpt-5.6",
            "model_patch": "diff --git a/widget.py b/widget.py\n",
        }
    ]
    # What SWE-bench Pro's own evaluator reads from --patch_path.
    pro = json.loads(prediction.patches_path.read_text(encoding="utf-8"))
    assert pro == [
        {
            "instance_id": "acme__widget-1234",
            "patch": "diff --git a/widget.py b/widget.py\n",
            "prefix": "terminus-live/gpt-5.6",
        }
    ]
    assert prediction.has_patch


# ──────────────────────────── evaluation states ───────────────────────────


def test_missing_harness_reports_evaluation_pending_with_the_patch_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("TERMINUS_SWEBENCH_PRO_HARNESS_DIR", raising=False)
    prediction = write_prediction_files(
        instance_id="i-1",
        model_name_or_path="terminus-live/gpt-5.6",
        model_patch="diff --git a/x b/x\n",
        output_dir=tmp_path / "predictions",
    )

    report = evaluate_prediction(prediction)
    assert report["status"] == "evaluation_pending"
    assert report["predictions_path"] == str(prediction.predictions_path)
    assert report["patches_path"] == str(prediction.patches_path)
    assert report["dataset_revision"] == SWE_BENCH_PRO_REVISION


def test_empty_patch_is_reported_as_no_patch_not_as_a_failure_to_grade(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("TERMINUS_SWEBENCH_PRO_HARNESS_DIR", raising=False)
    prediction = write_prediction_files(
        instance_id="i-1",
        model_name_or_path="terminus-live/gpt-5.6",
        model_patch="",
        output_dir=tmp_path / "predictions",
    )
    report = evaluate_prediction(prediction)
    assert report["status"] == "no_patch"


def _fake_pro_harness(tmp_path: Path, body: str) -> Path:
    harness_dir = tmp_path / "SWE-bench_Pro-os"
    (harness_dir / "run_scripts").mkdir(parents=True)
    script = harness_dir / "swe_bench_pro_eval.py"
    script.write_text(body, encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return harness_dir


def test_pinned_evaluator_is_invoked_and_its_verdict_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness_dir = _fake_pro_harness(
        tmp_path,
        "import json, pathlib, sys\n"
        "argv = sys.argv[1:]\n"
        "out = pathlib.Path([a for a in argv if a.startswith('--output_dir=')][0].split('=', 1)[1])\n"
        "out.mkdir(parents=True, exist_ok=True)\n"
        "(out / 'report.json').write_text(json.dumps({'results': [{'instance_id': 'i-1', 'resolved': True}]}))\n"
        "print(json.dumps({'received': argv}))\n",
    )
    monkeypatch.setenv("TERMINUS_SWEBENCH_PRO_HARNESS_DIR", str(harness_dir))

    prediction = write_prediction_files(
        instance_id="i-1",
        model_name_or_path="terminus-live/gpt-5.6",
        model_patch="diff --git a/x b/x\n",
        output_dir=tmp_path / "predictions",
    )
    report = evaluate_prediction(prediction)

    assert report["status"] == "invoked"
    assert report["exit_code"] == 0
    assert report["resolved"] is True
    assert report["argv"][0] == sys.executable
    received = json.loads(report["stdout_tail"].splitlines()[0])["received"]
    assert f"--patch_path={prediction.patches_path}" in received
    assert any(arg.startswith("--scripts_dir=") for arg in received)

    verdict = grader_result_for_report(report)
    assert verdict.passed is True
    assert verdict.score == 1.0
    assert verdict.grader_id == "swe-bench-pro:swe_bench_pro_eval"


def test_evaluator_that_writes_no_report_leaves_the_run_ungraded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A silent evaluator is not a failing verdict; it is an absent one."""
    harness_dir = _fake_pro_harness(tmp_path, "print('nothing to report')\n")
    monkeypatch.setenv("TERMINUS_SWEBENCH_PRO_HARNESS_DIR", str(harness_dir))

    prediction = write_prediction_files(
        instance_id="i-1",
        model_name_or_path="terminus-live/gpt-5.6",
        model_patch="diff --git a/x b/x\n",
        output_dir=tmp_path / "predictions",
    )
    report = evaluate_prediction(prediction)
    assert report["status"] == "evaluation_incomplete"

    verdict = grader_result_for_report(report)
    assert verdict.passed is False
    assert verdict.metadata["grader_status"] == "evaluation_incomplete"


def test_unresolved_instance_is_a_real_failure(tmp_path: Path) -> None:
    verdict = grader_result_for_report({"status": "invoked", "resolved": False, "exit_code": 0})
    assert verdict.passed is False
    assert verdict.metadata["resolved"] is False


def test_read_evaluation_report_finds_a_keyed_record(tmp_path: Path) -> None:
    """Some harness releases key the report by instance id instead of listing it."""
    results = tmp_path / "results"
    results.mkdir()
    (results / "out.json").write_text(json.dumps({"i-1": {"resolved": True}}), encoding="utf-8")
    found = read_evaluation_report(results, "i-1")
    assert found is not None and found["resolved"] is True
    assert read_evaluation_report(results, "other") is None


def test_read_evaluation_report_accepts_upstream_keyed_boolean(tmp_path: Path) -> None:
    """The pinned Pro evaluator writes ``{instance_id: bool}`` in eval_results.json."""
    results = tmp_path / "results"
    results.mkdir()
    (results / "eval_results.json").write_text(json.dumps({"i-1": True}), encoding="utf-8")

    found = read_evaluation_report(results, "i-1")

    assert found is not None
    assert found["resolved"] is True


def test_manifest_scoped_evaluation_requires_the_pinned_harness_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    harness_dir = _fake_pro_harness(tmp_path, "print('must not run')\n")
    monkeypatch.setenv("TERMINUS_SWEBENCH_PRO_HARNESS_DIR", str(harness_dir))
    prediction = write_prediction_files(
        instance_id="i-1",
        model_name_or_path="terminus-live/gpt-5.6",
        model_patch="diff --git a/x b/x\n",
        output_dir=tmp_path / "predictions",
    )

    report = evaluate_prediction(prediction, manifest_path=tmp_path / "swe-bench-pro.yaml")

    assert report["status"] == "evaluation_pending"
    assert report["harness_pin_verified"] is False
    assert SWE_BENCH_PRO_HARNESS_COMMIT in report["detail"]


def test_manifest_scoped_evaluation_reports_missing_raw_dataset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import forge_evals.runners.swebench_pro as swebench_pro

    harness_dir = _fake_pro_harness(tmp_path, "print('must not run')\n")
    monkeypatch.setenv("TERMINUS_SWEBENCH_PRO_HARNESS_DIR", str(harness_dir))
    monkeypatch.setattr(
        swebench_pro, "_harness_revision", lambda _path: SWE_BENCH_PRO_HARNESS_COMMIT
    )
    prediction = write_prediction_files(
        instance_id="i-1",
        model_name_or_path="terminus-live/gpt-5.6",
        model_patch="diff --git a/x b/x\n",
        output_dir=tmp_path / "predictions",
    )

    report = evaluate_prediction(prediction, manifest_path=tmp_path / "swe-bench-pro.yaml")

    assert report["status"] == "evaluation_pending"
    assert report["harness_pin_verified"] is True
    assert str(harness_dir / "swe_bench_pro_full.csv") in report["missing_evaluator_inputs"]
