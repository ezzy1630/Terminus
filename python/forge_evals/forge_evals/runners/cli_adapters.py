"""Non-interactive adapters for installed coding-agent CLIs.

The adapters in this module are intentionally small. They start a pinned CLI
in the task workspace, pass the same model identity used by the paired eval,
and turn the process result into the repository's :class:`HarnessResult`.
They do not provide a second tool implementation or a provider SDK.

Output is drained continuously so a verbose agent cannot deadlock the runner.
The run record receives a bounded tail, while the complete redacted stream is
written to an immutable run artifact and referenced by its SHA-256 digest.
That keeps JSON records small without silently throwing away evidence.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import signal
import subprocess
import tempfile
import time
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

from ..evidence import EvidenceClass
from ..run_record import CostBreakdown, Outcome
from .harness_runner import HarnessResult, RunRequest
from .trajectory_recorder import TrajectoryRecorder

__all__ = [
    "CliHarnessError",
    "OpenCodeCliAdapter",
    "PiCliAdapter",
]


_DEFAULT_OUTPUT_TAIL_BYTES = 16 * 1024
_ALLOWED_THINKING = frozenset({"off", "minimal", "low", "medium", "high", "xhigh", "max"})
_SECRET_PATTERNS = (
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"),
)


class CliHarnessError(RuntimeError):
    """Raised when a CLI invocation cannot be prepared safely."""


@dataclass(frozen=True)
class _OutputCapture:
    stream: str
    path: Path
    bytes_seen: int
    tail: str
    truncated: bool
    artifact_ref: str


@dataclass(frozen=True)
class _ProcessResult:
    returncode: int | None
    timed_out: bool
    stdout: _OutputCapture
    stderr: _OutputCapture
    wall_clock_ms: int


@dataclass
class _StreamBuffer:
    stream: str
    path: Path
    limit: int
    bytes_seen: int = 0
    _tail: bytearray = field(default_factory=bytearray)

    def append(self, chunk: bytes, output_file: Any) -> None:
        self.bytes_seen += len(chunk)
        output_file.write(chunk)
        self._tail.extend(chunk)
        if len(self._tail) > self.limit:
            del self._tail[: len(self._tail) - self.limit]

    def finish(self) -> _OutputCapture:
        raw = self.path.read_bytes()
        redacted = _redact_bytes(raw)
        if redacted != raw:
            self.path.write_bytes(redacted)
        digest = hashlib.sha256(redacted).hexdigest()
        return _OutputCapture(
            stream=self.stream,
            path=self.path,
            bytes_seen=self.bytes_seen,
            tail=_redact_bytes(bytes(self._tail)).decode("utf-8", errors="replace"),
            truncated=self.bytes_seen > self.limit,
            artifact_ref=f"artifact://sha256/{digest}",
        )


def _redact_bytes(value: bytes) -> bytes:
    text = value.decode("utf-8", errors="replace")
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(
            lambda match: f"{match.group(1)}[REDACTED]" if match.lastindex else "[REDACTED]",
            text,
        )
    return text.encode("utf-8")


def _model_identity(request: RunRequest) -> tuple[str, str, str]:
    provider = request.model_snapshot.provider.strip()
    model = request.model_snapshot.model.strip()
    if not provider or not model:
        raise CliHarnessError("model provider and model id are required")
    if "/" in model:
        prefixed_provider, unprefixed_model = model.split("/", 1)
        if prefixed_provider != provider:
            raise CliHarnessError(
                f"model provider mismatch: snapshot provider is {provider!r}, model is {model!r}"
            )
        model = unprefixed_model
    if not model:
        raise CliHarnessError("model id is empty after provider prefix")
    model_ref = f"{provider}/{model}"
    reasoning = (request.reasoning_effort or "").strip().lower()
    if reasoning and reasoning not in _ALLOWED_THINKING:
        raise CliHarnessError(f"unsupported reasoning effort {reasoning!r}")
    return provider, model, model_ref


def _instruction(request: RunRequest) -> str:
    if request.instruction is not None:
        instruction = request.instruction.strip()
        if not instruction:
            raise CliHarnessError("instruction cannot be empty")
        return instruction
    package_dir = request.task_package_dir or request.task_dir
    prompt = package_dir / "prompt.md"
    if prompt.is_file():
        value = prompt.read_text(encoding="utf-8").strip()
        if value:
            return value
    if request.task.strip():
        return request.task.strip()
    raise CliHarnessError("task instruction is missing")


def _reasoning_effort(request: RunRequest) -> str | None:
    value = (request.reasoning_effort or "").strip().lower()
    return value or None


def _artifact_dir(request: RunRequest, recorder: TrajectoryRecorder, root: Path | None) -> Path:
    target = root or Path(tempfile.gettempdir()) / "terminus-forge-cli-artifacts"
    target = target.expanduser().resolve() / recorder.run_id
    target.mkdir(parents=True, exist_ok=True)
    return target


def _capture_process(
    command: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    artifact_dir: Path,
    timeout_seconds: float,
    output_tail_bytes: int,
) -> _ProcessResult:
    started = time.monotonic()
    paths = {
        "stdout": artifact_dir / "stdout.log",
        "stderr": artifact_dir / "stderr.log",
    }
    buffers = {name: _StreamBuffer(name, path, output_tail_bytes) for name, path in paths.items()}
    try:
        process = subprocess.Popen(
            list(command),
            cwd=cwd,
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except (OSError, ValueError) as error:
        raise CliHarnessError(f"failed to start {command[0]!r}: {error}") from error

    selector = selectors.DefaultSelector()
    assert process.stdout is not None
    assert process.stderr is not None
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    files = {name: path.open("wb") for name, path in paths.items()}
    timed_out = False
    try:
        while selector.get_map():
            remaining = timeout_seconds - (time.monotonic() - started)
            if remaining <= 0:
                timed_out = True
                _terminate_process_group(process)
                remaining = 1.0
            for key, _ in selector.select(max(0.0, min(remaining, 0.25))):
                data = os.read(key.fd, 64 * 1024)
                if data:
                    buffers[key.data].append(data, files[key.data])
                else:
                    selector.unregister(key.fileobj)
            if timed_out and process.poll() is not None:
                # A killed process should close both pipes shortly. Continue
                # draining them instead of dropping the tail.
                continue
        try:
            returncode = process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            _terminate_process_group(process)
            returncode = process.wait(timeout=1.0)
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()
        for output_file in files.values():
            output_file.close()
    return _ProcessResult(
        returncode=returncode,
        timed_out=timed_out,
        stdout=buffers["stdout"].finish(),
        stderr=buffers["stderr"].finish(),
        wall_clock_ms=round((time.monotonic() - started) * 1000),
    )


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    with suppress(OSError, ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    with suppress(OSError, ProcessLookupError):
        if process.poll() is None:
            process.kill()


def _json_events(stdout: _OutputCapture) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    try:
        content = stdout.path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return events
    for line in content.splitlines():
        try:
            decoded = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(decoded, dict):
            events.append(decoded)
    if not events:
        try:
            decoded = json.loads(content)
        except json.JSONDecodeError:
            return events
        if isinstance(decoded, dict):
            events.append(decoded)
    return events


def _usage_from_events(
    events: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, int], float | None, int, int, str | None]:
    totals = {
        "input": 0,
        "cached": 0,
        "cache_write": 0,
        "output": 0,
        "reasoning": 0,
    }
    reported_cost: float | None = None
    steps = 0
    tool_errors = 0
    stop_reason: str | None = None

    def visit(value: object) -> None:
        nonlocal reported_cost, steps, tool_errors, stop_reason
        if isinstance(value, Mapping):
            event_type = str(value.get("type", ""))
            if event_type in {"step_start", "turn_start", "assistant", "message_start"}:
                steps += 1
            if event_type in {"tool_error", "error"} or value.get("is_error") is True:
                tool_errors += 1
            for key in ("stop_reason", "stopReason", "finish_reason", "finishReason"):
                if isinstance(value.get(key), str):
                    stop_reason = str(value[key])
                    break
            for key in ("usage", "tokens"):
                nested = value.get(key)
                if isinstance(nested, Mapping):
                    _add_usage(totals, nested)
                    cost = nested.get("cost")
                    if isinstance(cost, (int, float)):
                        reported_cost = float(cost)
            cost = value.get("cost")
            if isinstance(cost, (int, float)):
                reported_cost = float(cost)
            for nested in value.values():
                visit(nested)
        elif isinstance(value, list):
            for nested in value:
                visit(nested)

    for event in events:
        visit(event)
    return totals, reported_cost, steps, tool_errors, stop_reason


def _add_usage(totals: dict[str, int], usage: Mapping[str, Any]) -> None:
    aliases = {
        "input": ("input", "input_tokens", "prompt_tokens", "prompt"),
        "cached": ("cached", "cached_tokens", "cache_read", "cache_read_tokens", "read"),
        "cache_write": ("cache_write", "cache_write_tokens", "write"),
        "output": ("output", "output_tokens", "completion_tokens", "completion"),
        "reasoning": ("reasoning", "reasoning_tokens"),
    }
    cache = usage.get("cache")
    cache_mapping = cache if isinstance(cache, Mapping) else {}
    for name, keys in aliases.items():
        value: object = 0
        for key in keys:
            if isinstance(usage.get(key), (int, float)):
                value = usage[key]
                break
            if isinstance(cache_mapping.get(key), (int, float)):
                value = cache_mapping[key]
                break
        if isinstance(value, (int, float)):
            totals[name] += max(0, int(value))


def _result_for_process(
    request: RunRequest,
    recorder: TrajectoryRecorder,
    process: _ProcessResult,
    *,
    command: Sequence[str],
    provider: str,
    model: str,
    evidence_class: EvidenceClass,
) -> HarnessResult:
    events = _json_events(process.stdout)
    totals, reported_cost, steps, tool_errors, stop_reason = _usage_from_events(events)
    outcome = (
        Outcome.TIMEOUT
        if process.timed_out
        else Outcome.COMPLETED
        if process.returncode == 0
        else Outcome.FAILED
    )
    for event in events:
        event_type = str(event.get("type", ""))
        if event_type in {"tool_use", "tool_call", "tool_start"}:
            part = event.get("part")
            part_tool = part.get("tool") if isinstance(part, Mapping) else None
            tool = event.get("tool") or event.get("name") or part_tool
            if isinstance(tool, str):
                recorder.record_tool_proposed(
                    tool_call_id=f"cli-{recorder.event_count + 1}",
                    tool_name=tool,
                    arguments={"source": request.harness_id},
                )
    recorder.record(
        "provider.response_validated",
        {
            "provider": provider,
            "model": model,
            "exit_code": process.returncode,
            "structured_events": len(events),
        },
    )
    if outcome is Outcome.COMPLETED:
        recorder.record("turn.completed", {"turn": 1, "provider": provider, "model": model})
    artifact_payloads = []
    for capture in (process.stdout, process.stderr):
        artifact_payloads.append(
            {
                "kind": "cli_output",
                "stream": capture.stream,
                "path": str(capture.path),
                "artifact_ref": capture.artifact_ref,
                "bytes_seen": capture.bytes_seen,
                "tail": capture.tail,
                "truncated": capture.truncated,
            }
        )
    artifact_payloads.insert(
        0,
        {
            "kind": "cli_invocation",
            "argv": list(command),
            "cwd": str(request.task_dir.resolve()),
            "exit_code": process.returncode,
            "timed_out": process.timed_out,
        },
    )
    computed = ((totals["input"] - totals["cached"]) * 3.0 + totals["output"] * 15.0) / 1_000_000
    cost = CostBreakdown(
        provider_reported_usd=reported_cost,
        computed_usd=round(reported_cost if reported_cost is not None else computed, 6),
        input_tokens=max(0, totals["input"] - totals["cached"]),
        output_tokens=totals["output"],
        cached_tokens=totals["cached"],
        reasoning_tokens=totals["reasoning"],
        cache_write_tokens=totals["cache_write"],
        cache_read_tokens=totals["cached"],
        source="provider_reported" if reported_cost is not None else "price_table",
    )
    receipt_digest = hashlib.sha256(
        json.dumps(
            {
                "command": list(command),
                "stdout": process.stdout.artifact_ref,
                "stderr": process.stderr.artifact_ref,
                "exit_code": process.returncode,
            },
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    receipt = {
        "receipt_id": f"cli:{receipt_digest}",
        "provider": provider,
        "model": model,
        "artifact_ref": process.stdout.artifact_ref,
        "verified": process.returncode == 0 and not process.timed_out,
        "usage": totals,
        "exit_code": process.returncode,
    }
    note = (
        f"{request.harness_id} CLI exited {process.returncode}; "
        f"stdout={process.stdout.artifact_ref}, stderr={process.stderr.artifact_ref}"
    )
    if process.timed_out:
        note = f"{request.harness_id} CLI timed out after {process.wall_clock_ms}ms"
    return HarnessResult(
        outcome=outcome,
        final_revision="",
        cost=cost,
        artifacts=artifact_payloads,
        context_manifests=[],
        grader_outcomes=[],
        notes=note,
        metrics={
            "tokens_input_fresh": max(0, totals["input"] - totals["cached"]),
            "tokens_input_cached": totals["cached"],
            "tokens_output": totals["output"],
            "tokens_reasoning": totals["reasoning"],
            "steps": steps,
            "tool_error_rate": tool_errors / max(steps, 1),
            "wall_clock_ms": process.wall_clock_ms,
            "stop_reason": stop_reason,
        },
        evidence_class=evidence_class,
        independently_verified=False,
        provider_receipts=[receipt],
    )


@dataclass
class _BaseCliAdapter:
    """Shared settings for a CLI baseline."""

    executable: str = ""
    timeout_seconds: float | None = None
    output_tail_bytes: int = _DEFAULT_OUTPUT_TAIL_BYTES
    artifact_root: Path | None = None
    extra_env: Mapping[str, str] = field(default_factory=dict)
    evidence_class: EvidenceClass = EvidenceClass.EXTERNAL_LIVE

    def _run(
        self, request: RunRequest, recorder: TrajectoryRecorder, command: Sequence[str]
    ) -> HarnessResult:
        workspace = request.task_dir.expanduser().resolve()
        if not workspace.is_dir():
            raise CliHarnessError(f"task workspace is not a directory: {workspace}")
        if self.output_tail_bytes <= 0:
            raise CliHarnessError("output_tail_bytes must be positive")
        timeout = self.timeout_seconds
        if timeout is None:
            timeout = float(request.budgets.max_wall_seconds)
        if timeout <= 0:
            raise CliHarnessError("timeout_seconds must be positive")
        provider, model, _ = _model_identity(request)
        artifact_dir = _artifact_dir(request, recorder, self.artifact_root)
        env = os.environ.copy()
        env.update({str(key): str(value) for key, value in self.extra_env.items()})

        env.update(
            {
                "FORGE_EVAL_SUITE": request.suite,
                "FORGE_EVAL_TASK": request.task,
                "FORGE_EVAL_HARNESS": request.harness_id,
                "FORGE_EVAL_MODEL_PROVIDER": provider,
                "FORGE_EVAL_MODEL": model,
                "FORGE_EVAL_WORKSPACE": str(workspace),
                "CI": "1",
                "NO_COLOR": "1",
            }
        )
        if request.provider_account_id:
            # CLIs do not share a provider-account API, but fixtures and wrapper
            # scripts can still assert that the paired account pin survived the
            # adapter boundary without placing credentials in argv or output.
            env["FORGE_EVAL_PROVIDER_ACCOUNT_ID"] = request.provider_account_id
        recorder.record("task.activated", {"task": request.task, "harness": request.harness_id})
        recorder.record("turn.started", {"turn": 1})
        recorder.record("provider.request_sent", {"provider": provider, "model": model})
        process = _capture_process(
            command,
            cwd=workspace,
            env=env,
            artifact_dir=artifact_dir,
            timeout_seconds=timeout,
            output_tail_bytes=self.output_tail_bytes,
        )
        return _result_for_process(
            request,
            recorder,
            process,
            command=command,
            provider=provider,
            model=model,
            evidence_class=self.evidence_class,
        )


@dataclass
class OpenCodeCliAdapter(_BaseCliAdapter):
    """Run OpenCode's non-interactive JSON event stream in a task workspace."""

    harness_id: ClassVar[str] = "upstream_opencode"
    executable: str = "opencode"
    pure: bool = True

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        _, _, model_ref = _model_identity(request)
        command = [self.executable, "run"]
        if self.pure:
            command.append("--pure")
        command.extend(["--format", "json", "--model", model_ref])
        reasoning = _reasoning_effort(request)
        if reasoning:
            command.extend(["--variant", reasoning])
        command.extend(["--", _instruction(request)])
        return self._run(request, recorder, command)


@dataclass
class PiCliAdapter(_BaseCliAdapter):
    """Run Pi's ephemeral JSON mode without sessions or interactive input."""

    harness_id: ClassVar[str] = "pi"
    executable: str = "pi"
    no_extensions: bool = True
    no_skills: bool = True

    def run(self, request: RunRequest, recorder: TrajectoryRecorder) -> HarnessResult:
        provider, model, _ = _model_identity(request)
        command = [
            self.executable,
            "--print",
            "--no-session",
            "--mode",
            "json",
            "--provider",
            provider,
            "--model",
            model,
        ]
        reasoning = _reasoning_effort(request)
        if reasoning:
            command.extend(["--thinking", reasoning])
        if self.no_extensions:
            command.append("--no-extensions")
        if self.no_skills:
            command.append("--no-skills")
        command.extend(["--", _instruction(request)])
        return self._run(request, recorder, command)
