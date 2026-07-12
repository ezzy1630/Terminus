"""SPEC §46.8 fake provider — scripted, reproducible runtime testing.

Mirrors the ``@forge/testkit`` ``FakeProvider``. The Python fake provider
plays back a fixed sequence of *script steps* and emits chunks through an
async iterator (or, for tests, a synchronous generator that yields lists).

Supported script step kinds (SPEC §46.8):

- streaming text;
- tool calls (including malicious tool arguments);
- malformed schemas;
- transient errors;
- rate limits;
- continuation IDs;
- cache usage reports;
- long outputs;
- cancellation races.

The fake provider is **deterministic** — given the same script and seed, it
produces the same chunk sequence. It is required for reproducible runtime
testing (SPEC §46.8) and is the only provider used by the eval-smoke tier
(SPEC §46.11).
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Iterator, Literal

__all__ = [
    "FakeProvider",
    "FakeProviderChunk",
    "FakeProviderError",
    "FakeProviderOptions",
    "ScriptStep",
    "fake_malicious_tool_provider",
    "fake_text_provider",
    "fake_tool_call_provider",
]


class FakeProviderError(RuntimeError):
    """Raised when a fake provider script is invalid."""


# Step kinds (SPEC §46.8).
StepKind = Literal[
    "text",
    "tool_call",
    "tool_call_streaming",
    "error",
    "rate_limited",
    "usage",
    "cache_usage",
    "done",
    "malformed_schema",
    "long_output",
    "cancel_race",
]


@dataclass(frozen=True)
class ScriptStep:
    """A single scripted step in a fake provider stream.

    Field semantics mirror ``FakeProviderScriptStep`` in
    ``@forge/testkit`` so test scripts can be ported directly.
    """

    kind: StepKind
    text: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    tool_arguments: dict[str, Any] | None = None
    error_code: str | None = None
    error_message: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None
    reasoning_tokens: int | None = None
    cache_write_tokens: int | None = None
    cache_read_tokens: int | None = None
    retry_after_ms: int | None = None
    continuation_id: str | None = None
    # For long_output: number of identical chunks to emit.
    repeat: int = 1
    # For malformed_schema: the raw string to emit in place of valid JSON.
    raw_payload: str | None = None
    # For cancel_race: ms to sleep before checking cancellation.
    delay_ms: int = 0


class ChunkKind(str, Enum):
    """Fake provider chunk kinds (matches FakeProviderChunk in TS testkit)."""

    TEXT = "text"
    TOOL_CALL = "tool_call"
    ERROR = "error"
    DONE = "done"
    MALFORMED = "malformed"


@dataclass(frozen=True)
class Usage:
    """Token usage reported by a provider stream."""

    input_tokens: int
    output_tokens: int
    cached_tokens: int = 0
    reasoning_tokens: int = 0
    cache_write_tokens: int = 0
    cache_read_tokens: int = 0


@dataclass(frozen=True)
class FakeProviderChunk:
    """A single chunk emitted by :class:`FakeProvider`."""

    kind: ChunkKind
    text: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    tool_arguments: dict[str, Any] | None = None
    error_code: str | None = None
    error_message: str | None = None
    usage: Usage | None = None
    continuation_id: str | None = None
    retry_after_ms: int | None = None
    raw_payload: str | None = None


@dataclass
class FakeProviderOptions:
    """Options for :class:`FakeProvider`."""

    provider_id: str
    model: str
    steps: list[ScriptStep]
    continuation_id: str | None = None


class FakeProvider:
    """Scripted provider for tests (SPEC §46.8).

    Plays back a fixed sequence of steps. Supports streaming text, tool calls
    (including malicious-argument injection), malformed schemas, errors, rate
    limits, continuation IDs, cache-usage reporting, long outputs, and
    cancellation races.

    Usage::

        provider = FakeProvider(FakeProviderOptions(
            provider_id="fake",
            model="fake-1",
            steps=[
                ScriptStep(kind="text", text="hello "),
                ScriptStep(kind="text", text="world"),
                ScriptStep(kind="done"),
            ],
        ))
        chunks = list(provider.stream())
    """

    def __init__(self, opts: FakeProviderOptions) -> None:
        self.provider_id: str = opts.provider_id
        self.model: str = opts.model
        self._steps: list[ScriptStep] = list(opts.steps)
        self._continuation_id: str | None = opts.continuation_id
        self.recorded_requests: list[Any] = []
        self._counter: int = 0

    # ──────────────────────────── synchronous stream ──────────────────────

    def stream(
        self,
        request: Any | None = None,
        cancel_after_chunks: int | None = None,
    ) -> Iterator[FakeProviderChunk]:
        """Play back the script as a synchronous iterator.

        ``cancel_after_chunks`` simulates an abort signal after N chunks have
        been emitted (SPEC §46.8 — cancellation races). When set, the iterator
        yields an ``ERROR`` chunk with code ``CANCELLED`` and stops.
        """
        self.recorded_requests.append(request)
        yield from self._play(request, cancel_after_chunks=cancel_after_chunks)

    # ──────────────────────────── async stream ────────────────────────────

    async def astream(
        self,
        request: Any | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncIterator[FakeProviderChunk]:
        """Play back the script as an async iterator.

        ``cancel_event`` may be set externally to simulate a race between
        cancellation and provider response (SPEC §46.8).
        """
        self.recorded_requests.append(request)
        for chunk in self._play_sync_for_async():
            if cancel_event is not None and cancel_event.is_set():
                yield FakeProviderChunk(
                    kind=ChunkKind.ERROR, error_code="CANCELLED", error_message="aborted"
                )
                return
            # Yield control to the event loop between chunks.
            await asyncio.sleep(0)
            yield chunk

    def _play_sync_for_async(self) -> Iterator[FakeProviderChunk]:
        """Internal: drive the script for the async path."""
        yield from self._play(None)

    # ──────────────────────────── core playback ───────────────────────────

    def _play(
        self,
        request: Any | None,
        cancel_after_chunks: int | None = None,
    ) -> Iterator[FakeProviderChunk]:
        input_tokens = 0
        output_tokens = 0
        cached_tokens = 0
        reasoning_tokens = 0
        cache_write_tokens = 0
        cache_read_tokens = 0
        emitted_usage = False
        chunks_emitted = 0

        for step in self._steps:
            if cancel_after_chunks is not None and chunks_emitted >= cancel_after_chunks:
                yield FakeProviderChunk(
                    kind=ChunkKind.ERROR, error_code="CANCELLED", error_message="aborted"
                )
                return
            kind = step.kind
            if kind == "text":
                text = step.text or ""
                yield FakeProviderChunk(kind=ChunkKind.TEXT, text=text)
                output_tokens += -(-len(text) // 4)  # ceil(len/4)
                chunks_emitted += 1
            elif kind in ("tool_call", "tool_call_streaming"):
                self._counter += 1
                yield FakeProviderChunk(
                    kind=ChunkKind.TOOL_CALL,
                    tool_call_id=step.tool_call_id or f"call-{self._counter}",
                    tool_name=step.tool_name or "unknown",
                    tool_arguments=step.tool_arguments or {},
                )
                output_tokens += 10
                chunks_emitted += 1
            elif kind == "malformed_schema":
                # Emit a chunk whose tool_arguments are deliberately malformed
                # (e.g. a string instead of an object) per SPEC §46.8.
                yield FakeProviderChunk(
                    kind=ChunkKind.MALFORMED,
                    raw_payload=step.raw_payload or "{not valid json",
                    tool_name=step.tool_name,
                    tool_arguments=step.tool_arguments,
                )
                chunks_emitted += 1
            elif kind == "long_output":
                # Repeat the same text N times to simulate a very long output.
                text = step.text or ""
                for _ in range(max(1, step.repeat)):
                    yield FakeProviderChunk(kind=ChunkKind.TEXT, text=text)
                    output_tokens += -(-len(text) // 4)
                    chunks_emitted += 1
            elif kind == "cancel_race":
                # Sleep then check — caller should set cancel between.
                if step.delay_ms > 0:
                    time.sleep(step.delay_ms / 1000.0)
                yield FakeProviderChunk(
                    kind=ChunkKind.TEXT, text=step.text or "[cancel-race]"
                )
                chunks_emitted += 1
            elif kind == "error":
                yield FakeProviderChunk(
                    kind=ChunkKind.ERROR,
                    error_code=step.error_code or "PROVIDER_RESPONSE_INVALID",
                    error_message=step.error_message or "unknown",
                )
                return
            elif kind == "rate_limited":
                yield FakeProviderChunk(
                    kind=ChunkKind.ERROR,
                    error_code="PROVIDER_RATE_LIMITED",
                    error_message="rate limited",
                    retry_after_ms=step.retry_after_ms or 1000,
                )
                return
            elif kind == "usage":
                input_tokens = step.input_tokens if step.input_tokens is not None else input_tokens
                output_tokens = (
                    step.output_tokens if step.output_tokens is not None else output_tokens
                )
                cached_tokens = (
                    step.cached_tokens if step.cached_tokens is not None else cached_tokens
                )
                reasoning_tokens = (
                    step.reasoning_tokens
                    if step.reasoning_tokens is not None
                    else reasoning_tokens
                )
                cache_write_tokens = (
                    step.cache_write_tokens
                    if step.cache_write_tokens is not None
                    else cache_write_tokens
                )
                cache_read_tokens = (
                    step.cache_read_tokens
                    if step.cache_read_tokens is not None
                    else cache_read_tokens
                )
                emitted_usage = True
            elif kind == "cache_usage":
                cached_tokens = (
                    step.cached_tokens if step.cached_tokens is not None else cached_tokens
                )
            elif kind == "done":
                usage = Usage(
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cached_tokens=cached_tokens,
                    reasoning_tokens=reasoning_tokens,
                    cache_write_tokens=cache_write_tokens,
                    cache_read_tokens=cache_read_tokens,
                )
                yield FakeProviderChunk(
                    kind=ChunkKind.DONE,
                    usage=usage,
                    continuation_id=step.continuation_id or self._continuation_id,
                )
                return
            else:  # pragma: no cover - exhaustive literal
                raise FakeProviderError(f"unexpected step kind: {kind!r}")

        # If no explicit "done", emit one.
        usage = Usage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            reasoning_tokens=reasoning_tokens,
            cache_write_tokens=cache_write_tokens,
            cache_read_tokens=cache_read_tokens,
        )
        yield FakeProviderChunk(
            kind=ChunkKind.DONE,
            usage=usage,
            continuation_id=self._continuation_id,
        )

    # ──────────────────────────── convenience ─────────────────────────────

    def collect(self, request: Any | None = None) -> list[FakeProviderChunk]:
        """Play back the script and return all chunks as a list."""
        return list(self.stream(request=request))

    def collect_text(self, request: Any | None = None) -> str:
        """Concatenate all TEXT chunks into a single string."""
        return "".join(c.text or "" for c in self.stream(request=request) if c.kind is ChunkKind.TEXT)


# ──────────────────────────── builders ────────────────────────────────────


def fake_text_provider(provider_id: str, model: str, text: str) -> FakeProvider:
    """Build a fake provider that streams a single text response and ends."""
    return FakeProvider(
        FakeProviderOptions(
            provider_id=provider_id,
            model=model,
            steps=[ScriptStep(kind="text", text=text), ScriptStep(kind="done")],
        )
    )


def fake_tool_call_provider(
    provider_id: str,
    model: str,
    tool_name: str,
    args: dict[str, Any],
) -> FakeProvider:
    """Build a fake provider that returns a single tool call."""
    return FakeProvider(
        FakeProviderOptions(
            provider_id=provider_id,
            model=model,
            steps=[ScriptStep(kind="tool_call", tool_name=tool_name, tool_arguments=args),
                   ScriptStep(kind="done")],
        )
    )


def fake_malicious_tool_provider(
    provider_id: str,
    model: str,
    tool_name: str,
    malicious_args: dict[str, Any],
) -> FakeProvider:
    """Build a fake provider that emits a tool call with malicious arguments.

    Used by the security graders (SPEC §41.11, §46.10) to verify the policy
    layer rejects the call before settlement.
    """
    return FakeProvider(
        FakeProviderOptions(
            provider_id=provider_id,
            model=model,
            steps=[
                ScriptStep(kind="tool_call", tool_name=tool_name, tool_arguments=malicious_args),
                ScriptStep(kind="done"),
            ],
        )
    )


@dataclass
class FakeProviderBuilder:
    """Fluent builder for :class:`FakeProvider`."""

    provider_id: str = "fake"
    model: str = "fake-1"
    steps: list[ScriptStep] = field(default_factory=list)
    continuation_id: str | None = None

    def text(self, s: str) -> FakeProviderBuilder:
        self.steps.append(ScriptStep(kind="text", text=s))
        return self

    def tool_call(
        self, name: str, args: dict[str, Any] | None = None, call_id: str | None = None
    ) -> FakeProviderBuilder:
        self.steps.append(
            ScriptStep(kind="tool_call", tool_name=name, tool_arguments=args or {},
                       tool_call_id=call_id)
        )
        return self

    def malformed(self, name: str, raw: str) -> FakeProviderBuilder:
        self.steps.append(ScriptStep(kind="malformed_schema", tool_name=name, raw_payload=raw))
        return self

    def error(self, code: str, message: str) -> FakeProviderBuilder:
        self.steps.append(ScriptStep(kind="error", error_code=code, error_message=message))
        return self

    def rate_limited(self, retry_after_ms: int = 1000) -> FakeProviderBuilder:
        self.steps.append(ScriptStep(kind="rate_limited", retry_after_ms=retry_after_ms))
        return self

    def usage(
        self,
        *,
        input_tokens: int = 0,
        output_tokens: int = 0,
        cached_tokens: int = 0,
        reasoning_tokens: int = 0,
        cache_write_tokens: int = 0,
        cache_read_tokens: int = 0,
    ) -> FakeProviderBuilder:
        self.steps.append(
            ScriptStep(
                kind="usage",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cached_tokens=cached_tokens,
                reasoning_tokens=reasoning_tokens,
                cache_write_tokens=cache_write_tokens,
                cache_read_tokens=cache_read_tokens,
            )
        )
        return self

    def cache_usage(self, cached_tokens: int) -> FakeProviderBuilder:
        self.steps.append(ScriptStep(kind="cache_usage", cached_tokens=cached_tokens))
        return self

    def long_output(self, text: str, repeat: int) -> FakeProviderBuilder:
        self.steps.append(ScriptStep(kind="long_output", text=text, repeat=repeat))
        return self

    def cancel_race(self, delay_ms: int, text: str = "[race]") -> FakeProviderBuilder:
        self.steps.append(ScriptStep(kind="cancel_race", delay_ms=delay_ms, text=text))
        return self

    def done(self) -> FakeProviderBuilder:
        self.steps.append(ScriptStep(kind="done"))
        return self

    def build(self) -> FakeProvider:
        """Construct the :class:`FakeProvider`."""
        return FakeProvider(
            FakeProviderOptions(
                provider_id=self.provider_id,
                model=self.model,
                steps=list(self.steps),
                continuation_id=self.continuation_id,
            )
        )


def chunks_to_jsonable(chunks: list[FakeProviderChunk]) -> list[dict[str, Any]]:
    """Convert a list of chunks to plain JSON-safe dicts (for trajectory records)."""

    def _usage(u: Usage | None) -> dict[str, int] | None:
        if u is None:
            return None
        return {
            "input_tokens": u.input_tokens,
            "output_tokens": u.output_tokens,
            "cached_tokens": u.cached_tokens,
            "reasoning_tokens": u.reasoning_tokens,
            "cache_write_tokens": u.cache_write_tokens,
            "cache_read_tokens": u.cache_read_tokens,
        }

    out: list[dict[str, Any]] = []
    for c in chunks:
        out.append(
            {
                "kind": c.kind.value,
                "text": c.text,
                "tool_call_id": c.tool_call_id,
                "tool_name": c.tool_name,
                "tool_arguments": c.tool_arguments,
                "error_code": c.error_code,
                "error_message": c.error_message,
                "usage": _usage(c.usage),
                "continuation_id": c.continuation_id,
                "retry_after_ms": c.retry_after_ms,
                "raw_payload": c.raw_payload,
            }
        )
    return out


def chunks_to_json(chunks: list[FakeProviderChunk]) -> str:
    """Serialize chunks to a JSON string (for Parquet storage)."""
    return json.dumps(chunks_to_jsonable(chunks), sort_keys=True)
