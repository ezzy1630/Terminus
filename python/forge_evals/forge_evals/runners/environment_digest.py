"""Content-addressed environment digest for a live run.

``evals/registry.yaml`` requires every release-eligible run manifest to carry
an ``environment_image_digest``, and the local exit gate requires the run
record's ``environment_digest`` to match ``sha256:<64 hex>`` exactly. A label
such as ``remote:<workspace id>`` satisfies neither: it identifies a session,
not an environment, and two different fixtures produce the same string.

This module builds the real thing from three components:

``workspace_tree``
    A content hash over the checked-out fixture tree at run start — every
    regular file's path, executable bit, and SHA-256, plus symlink targets.
    ``.git`` and other machine-local caches are excluded so the digest tracks
    the *content* the agent sees, not the VCS metadata around it.

``task_package``
    A hash over the task package's declaration files (``task.yaml``,
    ``setup.sh``, ``environment.lock``, ``policy.yaml``), which pin the
    intended environment rather than the materialised one.

``runtime_identity``
    The control plane's reported build and sandbox identity. Deliberately
    **excludes** the control plane's ``instance_id``: a per-process nonce in a
    digest poisons every comparison across restarts (the same defect the audit
    records for ``verification-runtime.ts``'s use of the kernel ``instanceId``).

The three are folded into one ``sha256:`` digest, and the components are kept
alongside so the digest can be re-derived and audited.
"""

from __future__ import annotations

import hashlib
import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

__all__ = [
    "DEFAULT_EXCLUDED_DIRS",
    "LiveEnvironmentDigest",
    "hash_workspace_tree",
    "runtime_identity_string",
]

DEFAULT_EXCLUDED_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".terminus",
        ".venv",
        "node_modules",
        "target",
        ".DS_Store",
    }
)

_TASK_DECLARATION_FILES = ("task.yaml", "setup.sh", "environment.lock", "policy.yaml")
_EMPTY_TREE = "sha256:" + hashlib.sha256(b"").hexdigest()


def _iter_tree(root: Path, excluded: frozenset[str]) -> Iterable[tuple[str, Path]]:
    """Yield ``(relative posix path, absolute path)`` in deterministic order."""
    entries: list[tuple[str, Path]] = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(name for name in dirnames if name not in excluded)
        current = Path(dirpath)
        for filename in sorted(filenames):
            if filename in excluded:
                continue
            absolute = current / filename
            try:
                relative = absolute.relative_to(root).as_posix()
            except ValueError:  # pragma: no cover - defensive
                continue
            entries.append((relative, absolute))
    entries.sort(key=lambda item: item[0])
    return entries


def hash_workspace_tree(
    root: Path | str,
    *,
    excluded_dirs: frozenset[str] = DEFAULT_EXCLUDED_DIRS,
) -> str:
    """Return ``sha256:<hex>`` over the content of the tree at ``root``.

    Unreadable files are recorded as such rather than skipped: a permission
    error is part of the environment and must change the digest.
    """
    base = Path(root)
    if not base.is_dir():
        return _EMPTY_TREE
    digest = hashlib.sha256()
    for relative, absolute in _iter_tree(base, excluded_dirs):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\x00")
        if absolute.is_symlink():
            digest.update(b"symlink\x00")
            try:
                digest.update(os.readlink(absolute).encode("utf-8"))
            except OSError as exc:
                digest.update(f"unreadable:{exc.errno}".encode())
            digest.update(b"\n")
            continue
        try:
            stat = absolute.stat()
            executable = b"1" if stat.st_mode & 0o111 else b"0"
            file_digest = hashlib.sha256()
            with absolute.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    file_digest.update(chunk)
            digest.update(executable)
            digest.update(b"\x00")
            digest.update(file_digest.hexdigest().encode("ascii"))
        except OSError as exc:
            digest.update(f"unreadable:{exc.errno}".encode())
        digest.update(b"\n")
    return "sha256:" + digest.hexdigest()


def hash_task_package(task_dir: Path | str) -> str:
    """Return ``sha256:<hex>`` over a task package's declaration files."""
    d = Path(task_dir)
    digest = hashlib.sha256()
    for name in _TASK_DECLARATION_FILES:
        path = d / name
        digest.update(name.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(path.read_bytes() if path.is_file() else b"")
        digest.update(b"\n")
    return "sha256:" + digest.hexdigest()


def runtime_identity_string(
    health: Mapping[str, Any] | None,
    sandbox_report: Mapping[str, Any] | None = None,
) -> str:
    """Fold the control plane's *stable* identity into one string.

    ``GET /v1/system/health`` returns ``version``, ``build_commit``,
    ``instance_id`` and a ``kernel`` block carrying live health plus
    ``kernel.version`` / ``kernel.build_digest`` (Phase 0-F2);
    ``GET /v1/sandbox/report`` returns ``backend_id``, ``status`` and
    ``profile_id``.

    Only build identity participates. ``instance_id`` — the control plane's and
    the kernel's alike — is a fresh uuid on every start, and the kernel's
    ``state`` is live health; folding either in would make two runs of the same
    build produce different environment digests, which is the whole failure the
    digest exists to catch.
    """
    parts: list[str] = []
    if isinstance(health, Mapping):
        parts.append(f"control_version={health.get('version') or 'unknown'}")
        parts.append(f"control_build_commit={health.get('build_commit') or 'unknown'}")
        kernel = health.get("kernel")
        if isinstance(kernel, Mapping):
            # `build_digest` is stable across restarts by construction: it is
            # the kernel's build revision, or a hash of its declared capability
            # surface when the revision is a placeholder.
            for key in ("version", "build_digest", "build_commit", "protocol_version"):
                value = kernel.get(key)
                if isinstance(value, (str, int)) and str(value):
                    parts.append(f"kernel_{key}={value}")
    else:
        parts.append("control_version=unavailable")
    if isinstance(sandbox_report, Mapping):
        parts.append(f"sandbox_backend={sandbox_report.get('backend_id') or 'unknown'}")
        parts.append(f"sandbox_status={sandbox_report.get('status') or 'unknown'}")
        profile_id = sandbox_report.get("profile_id")
        if isinstance(profile_id, str) and profile_id:
            parts.append(f"sandbox_profile={profile_id}")
    else:
        parts.append("sandbox=unavailable")
    return ";".join(parts)


@dataclass(frozen=True)
class LiveEnvironmentDigest:
    """A content-addressed digest of the environment one live run executed in."""

    workspace_tree_digest: str
    task_package_digest: str
    runtime_identity: str
    extra: dict[str, str] = field(default_factory=dict)

    @classmethod
    def build(
        cls,
        *,
        workspace_root: Path | str,
        task_dir: Path | str | None = None,
        health: Mapping[str, Any] | None = None,
        sandbox_report: Mapping[str, Any] | None = None,
        extra: Mapping[str, str] | None = None,
    ) -> LiveEnvironmentDigest:
        """Hash the fixture tree and fold in the control plane's identity."""
        return cls(
            workspace_tree_digest=hash_workspace_tree(workspace_root),
            task_package_digest=hash_task_package(task_dir or workspace_root),
            runtime_identity=runtime_identity_string(health, sandbox_report),
            extra=dict(extra or {}),
        )

    def to_digest(self) -> str:
        """Return the single ``sha256:<64 hex>`` digest for the run record."""
        digest = hashlib.sha256()
        for label, value in (
            ("workspace_tree", self.workspace_tree_digest),
            ("task_package", self.task_package_digest),
            ("runtime_identity", self.runtime_identity),
        ):
            digest.update(label.encode("utf-8"))
            digest.update(b"\x00")
            digest.update(value.encode("utf-8"))
            digest.update(b"\n")
        for key in sorted(self.extra):
            digest.update(key.encode("utf-8"))
            digest.update(b"\x00")
            digest.update(self.extra[key].encode("utf-8"))
            digest.update(b"\n")
        return "sha256:" + digest.hexdigest()

    def to_dict(self) -> dict[str, Any]:
        """Auditable component record stored beside the digest."""
        return {
            "kind": "environment_digest",
            "digest": self.to_digest(),
            "workspace_tree_digest": self.workspace_tree_digest,
            "task_package_digest": self.task_package_digest,
            "runtime_identity": self.runtime_identity,
            **({"extra": dict(self.extra)} if self.extra else {}),
        }
