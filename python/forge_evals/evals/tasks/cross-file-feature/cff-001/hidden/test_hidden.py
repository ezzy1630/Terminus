"""Private behavior checks for the cross-file retry feature."""

import inspect

from src.api import API
from src.cli import show_user
from src.client import Client
from src.scheduler import refresh


def test_retry_is_optional_and_defaults_to_zero() -> None:
    parameter = inspect.signature(Client.request).parameters["retry"]
    assert parameter.default == 0
    assert Client().request("/health") == {"path": "/health", "payload": {}}


def test_each_idempotent_entry_point_passes_three_retries() -> None:
    calls: list[tuple[str, dict[str, object]]] = []
    client = Client()
    client.request = (  # type: ignore[method-assign]
        lambda path, payload=None, **kwargs: calls.append((path, kwargs)) or {"path": path}
    )
    API(client).list_users()
    show_user(client, "7")
    refresh(client)
    assert calls == [
        ("/users", {"retry": 3}),
        ("/users/7", {"retry": 3}),
        ("/refresh", {"retry": 3}),
    ]
