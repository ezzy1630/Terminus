"""Terminus agent shim for Harbor (Terminal-Bench).

Harbor drives one *agent* per task. The agent object is constructed by Harbor
in the harness process and is handed a :class:`BaseEnvironment` handle onto the
task's Docker container plus the task instruction; Harbor's own verifier then
grades the container after the agent returns. Harbor accepts a custom agent as
an import path::

    harbor run -d terminal-bench/terminal-bench-2@2.0 \\
        --agent forge_evals.runners.harbor_agent:TerminusHarborAgent \\
        --ae TERMINUS_CONTROL_URL=... --ae TERMINUS_CONTROL_TOKEN=...

Terminus cannot run *inside* an arbitrary benchmark container — the kernel,
sandbox and control plane are host processes. The shim therefore bridges the
two: it materialises the container's working directory on the host, opens it as
a Terminus workspace, runs exactly one turn against the task instruction, waits
for the terminal event, writes the resulting tree back into the container
(including deletions), and returns so Harbor's tests grade the container.

Required environment (forwarded into the agent with Harbor's ``--ae`` flag):

``TERMINUS_CONTROL_URL``
    Base URL of a running terminus-control instance, reachable from the host
    process running Harbor (for example ``http://127.0.0.1:3050``).
``TERMINUS_CONTROL_TOKEN``
    Bearer token for that instance (``.terminus-dev/control.token`` under the
    dev stack).

Optional environment:

``TERMINUS_HARBOR_WORKDIR``   container path to treat as the workspace (default ``/app``)
``TERMINUS_MODEL``            model id to steer the turn with
``TERMINUS_REASONING_EFFORT`` ``low`` | ``medium`` | ``high`` | ``max``
``TERMINUS_TURN_TIMEOUT_S``   harness timeout in seconds (default 1800)
``TERMINUS_HARNESS_COMMIT``   immutable source digest or revision under test

The module imports cleanly without Harbor installed: the Harbor base class is
resolved lazily and falls back to a local stand-in so the shim's logic stays
unit-testable on a machine with no Docker and no Harbor.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from ..run_record import Outcome
from .harness_runner import Budgets, HarnessResult, ModelCapabilitySnapshot, RunRequest
from .trajectory_recorder import TrajectoryRecorder

__all__ = [
    "TERMINUS_HARBOR_AGENT_IMPORT_PATH",
    "HarborWorkspaceBridge",
    "TerminusHarborAgent",
    "harbor_agent_env",
]

TERMINUS_HARBOR_AGENT_IMPORT_PATH = "forge_evals.runners.harbor_agent:TerminusHarborAgent"

_DEFAULT_WORKDIR = "/app"
_DEFAULT_TIMEOUT_SECONDS = 1_800.0
_AGENT_NAME = "terminus"


def _resolve_base_agent() -> type:
    """Return Harbor's ``BaseAgent`` when installed, else a local stand-in.

    Harbor is a heavy, Docker-bound dependency that the eval lab does not
    vendor. Importing it lazily keeps this module usable (and testable) on a
    machine without Harbor while still subclassing the real base class when
    Harbor loads the shim by import path.
    """
    try:  # pragma: no cover - exercised only where Harbor is installed
        from harbor.agents.base import BaseAgent

        return cast(type, BaseAgent)
    except Exception:
        return _StandaloneAgentBase


class _StandaloneAgentBase:
    """Minimal stand-in for ``harbor.agents.base.BaseAgent``.

    Only the constructor surface the shim actually uses is reproduced. It
    exists so the shim can be constructed and unit-tested without Harbor; it
    is never used when Harbor is present.
    """

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        **kwargs: Any,
    ) -> None:
        self.logs_dir = Path(logs_dir)
        self.model_name = model_name
        self._extra_env: dict[str, str] = dict(kwargs.get("extra_env") or {})

    @property
    def extra_env(self) -> dict[str, str]:
        return dict(self._extra_env)


def harbor_agent_env(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return the environment Harbor must forward into the agent.

    Raises ``RuntimeError`` when the control plane is not configured, because
    an agent that cannot reach Terminus would otherwise run the whole benchmark
    and score zero for the wrong reason.
    """
    source = environ if environ is not None else os.environ
    url = source.get("TERMINUS_CONTROL_URL")
    if not url:
        raise RuntimeError(
            "TERMINUS_CONTROL_URL is not set; the Harbor agent shim has no control plane to drive"
        )
    forwarded = {"TERMINUS_CONTROL_URL": url}
    for name in (
        "TERMINUS_CONTROL_TOKEN",
        "TERMINUS_HARBOR_WORKDIR",
        "TERMINUS_MODEL",
        "TERMINUS_REASONING_EFFORT",
        "TERMINUS_TURN_TIMEOUT_S",
        "TERMINUS_HARNESS_COMMIT",
    ):
        value = source.get(name)
        if value:
            forwarded[name] = value
    return forwarded


def _snapshot_tree(root: Path) -> dict[str, float]:
    """Map every relative file path under ``root`` to its mtime."""
    out: dict[str, float] = {}
    for path in root.rglob("*"):
        if path.is_file() or path.is_symlink():
            try:
                out[path.relative_to(root).as_posix()] = path.lstat().st_mtime
            except OSError:  # pragma: no cover - defensive
                continue
    return out


@dataclass
class HarborWorkspaceBridge:
    """Move a container working directory to the host and back.

    Harbor's ``BaseEnvironment`` exposes ``download_dir`` / ``upload_dir`` /
    ``exec``. Uploading alone is not a faithful write-back — a file the agent
    deleted on the host would survive in the container — so deletions are
    replayed explicitly.
    """

    environment: Any
    container_workdir: str = _DEFAULT_WORKDIR

    async def download(self, host_root: Path) -> dict[str, float]:
        """Copy the container workdir onto the host; return the initial tree."""
        host_root.mkdir(parents=True, exist_ok=True)
        await self.environment.download_dir(self.container_workdir, host_root)
        return _snapshot_tree(host_root)

    async def upload(self, host_root: Path, before: Mapping[str, float]) -> dict[str, Any]:
        """Write the host tree back, replaying deletions."""
        after = _snapshot_tree(host_root)
        deleted = sorted(set(before) - set(after))
        changed = sorted(
            path for path, mtime in after.items() if before.get(path) != mtime
        )
        await self.environment.upload_dir(host_root, self.container_workdir)
        for relative in deleted:
            target = f"{self.container_workdir.rstrip('/')}/{relative}"
            await self.environment.exec(command=f"rm -f -- {_shell_quote(target)}")
        return {
            "files_before": len(before),
            "files_after": len(after),
            "files_changed": changed,
            "files_deleted": deleted,
        }


def _shell_quote(value: str) -> str:
    """Single-quote a path for a POSIX shell command."""
    return "'" + value.replace("'", "'\"'\"'") + "'"


class TerminusHarborAgent(_resolve_base_agent()):  # type: ignore[misc]
    """Harbor agent that delegates one task to a live Terminus turn."""

    # Harbor reads these class attributes; the defaults are the honest ones.
    SUPPORTS_ATIF = False
    SUPPORTS_RESUME = False
    SUPPORTS_WINDOWS = False

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        *args: Any,
        harness_factory: Any = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir, model_name, *args, **kwargs)
        self._harness_factory = harness_factory
        self._summary: dict[str, Any] = {}

    @staticmethod
    def name() -> str:
        return _AGENT_NAME

    def version(self) -> str:
        from .. import __version__ as package_version

        return str(package_version)

    # -- configuration -----------------------------------------------------

    def _env(self, key: str, default: str | None = None) -> str | None:
        extra = getattr(self, "extra_env", {}) or {}
        value = extra.get(key) or os.environ.get(key)
        return value if value else default

    @property
    def container_workdir(self) -> str:
        return self._env("TERMINUS_HARBOR_WORKDIR", _DEFAULT_WORKDIR) or _DEFAULT_WORKDIR

    def _build_harness(self) -> Any:
        if self._harness_factory is not None:
            return self._harness_factory()
        from .terminus_harness import TerminusControlError, TerminusHarness, TerminusHarnessConfig

        base_url = self._env("TERMINUS_CONTROL_URL")
        if not base_url:
            raise TerminusControlError(
                "TERMINUS_CONTROL_URL is not set inside the Harbor agent; "
                "forward it with `harbor run --ae TERMINUS_CONTROL_URL=...`"
            )
        timeout_raw = self._env("TERMINUS_TURN_TIMEOUT_S")
        try:
            timeout = float(timeout_raw) if timeout_raw else _DEFAULT_TIMEOUT_SECONDS
        except ValueError:
            timeout = _DEFAULT_TIMEOUT_SECONDS
        return TerminusHarness(
            TerminusHarnessConfig(
                base_url=base_url.rstrip("/"),
                token=self._env("TERMINUS_CONTROL_TOKEN"),
                timeout_seconds=timeout,
            )
        )

    def _run_request(self, instruction: str, workspace: Path, task_name: str) -> RunRequest:
        model = self.model_name or self._env("TERMINUS_MODEL") or ""
        # Harbor's task prose names the in-container workdir (normally
        # `/app`), while Terminus deliberately runs against a host snapshot at
        # a random path. Without this mapping, a correct model follows the
        # user's absolute path and the kernel rightly denies it as outside the
        # workspace. Keep the task unchanged and append the execution fact.
        bridged_instruction = (
            f"{instruction.rstrip()}\n\n"
            "Harbor workspace mapping: "
            f"{self.container_workdir} is the current Terminus workspace root. "
            "Use workspace-relative paths (for example, "
            f"{self.container_workdir.rstrip('/')}/file.txt is file.txt). "
            "Do not access the host path named in this note."
        )
        return RunRequest(
            suite="terminal-bench",
            task=task_name,
            task_dir=workspace,
            harness_id="terminus-live",
            harness_commit=self._env("TERMINUS_HARNESS_COMMIT", "git:HEAD") or "git:HEAD",
            model_snapshot=ModelCapabilitySnapshot(
                provider="terminus",
                model=model,
                api_version=self._env("TERMINUS_LIVE_API_VERSION", "2026-08") or "2026-08",
                context_window=200_000,
                max_output_tokens=8_192,
                supports_tool_calls=True,
                supports_streaming=True,
                supports_cache=True,
            ),
            random_seed=0,
            budgets=Budgets(),
            reasoning_effort=self._env("TERMINUS_REASONING_EFFORT"),
            instruction=bridged_instruction,
        )

    # -- Harbor agent protocol --------------------------------------------

    async def setup(self, environment: Any) -> None:
        """Verify the control plane is reachable before the task starts."""
        harness = self._build_harness()
        health = await asyncio.to_thread(harness.health)
        self._summary["control_plane_health"] = health
        if health is None:
            raise RuntimeError(
                "terminus control plane did not answer GET /v1/system/health; "
                "the Harbor agent has nothing to drive"
            )

    async def run(self, instruction: str, environment: Any, context: Any = None) -> None:
        """Run exactly one Terminus turn against the container's workdir."""
        task_name = str(getattr(context, "task_name", None) or "terminal-bench-task")
        bridge = HarborWorkspaceBridge(environment, self.container_workdir)
        host_root = Path(tempfile.mkdtemp(prefix="terminus-harbor-"))
        try:
            before = await bridge.download(host_root)
            harness = self._build_harness()
            request = self._run_request(instruction, host_root, task_name)
            recorder = TrajectoryRecorder(run_id=f"harbor-{task_name}")
            result: HarnessResult = await asyncio.to_thread(harness.run, request, recorder)
            sync = await bridge.upload(host_root, before)
            self._summary.update(
                {
                    "task_name": task_name,
                    "outcome": result.outcome.value
                    if isinstance(result.outcome, Outcome)
                    else str(result.outcome),
                    "metrics": dict(result.metrics),
                    "harness_notes": result.notes,
                    "workspace_sync": sync,
                    "container_workdir": self.container_workdir,
                }
            )
        finally:
            self._write_summary()
            shutil.rmtree(host_root, ignore_errors=True)

    def _write_summary(self) -> None:
        """Persist what the shim did into Harbor's per-trial agent log dir."""
        try:
            self.logs_dir.mkdir(parents=True, exist_ok=True)
            (self.logs_dir / "terminus-agent.json").write_text(
                json.dumps(self._summary, indent=2, sort_keys=True, default=str),
                encoding="utf-8",
            )
        except OSError:  # pragma: no cover - a log write must not fail the trial
            pass
