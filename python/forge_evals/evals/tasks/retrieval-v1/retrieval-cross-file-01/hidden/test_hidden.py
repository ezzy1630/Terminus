"""Hidden integration tests for ApiClient retry propagation."""
import pytest
from src.api import fetch_user
from src.cli import run_sync
from src.client import ApiClient
from src.scheduler import dispatch_batch_job


def test_client_rejects_negative_retries():
    client = ApiClient()
    with pytest.raises(ValueError, match="retry_count must be non-negative"):
        client.request("/test", retry_count=-1)


def test_scheduler_passes_five_retries():
    client = ApiClient()
    res = dispatch_batch_job(client)
    if res["retries_allowed"] != 5 or res["endpoint"] != "/jobs/batch":
        raise AssertionError(f"scheduler retry mismatch: {res}")


def test_custom_api_retries():
    client = ApiClient()
    res = fetch_user(client, "usr_99", retries=4)
    if res["retries_allowed"] != 4 or res["endpoint"] != "/users/usr_99":
        raise AssertionError(f"api retry mismatch: {res}")


def test_cli_sync_retries():
    client = ApiClient()
    res = run_sync(client, retries=7)
    if res["retries_allowed"] != 7 or res["endpoint"] != "/sync/now":
        raise AssertionError(f"cli sync retry mismatch: {res}")
