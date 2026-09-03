"""Hidden integration tests for ApiClient retry propagation."""
import pytest
from src.api import fetch_user
from src.client import ApiClient
from src.scheduler import dispatch_batch_job


def test_client_rejects_negative_retries():
    client = ApiClient()
    with pytest.raises(ValueError, match="retry_count must be non-negative"):
        client.request("/test", retry_count=-1)


def test_scheduler_passes_five_retries():
    client = ApiClient()
    res = dispatch_batch_job(client)
    assert res["retries_allowed"] == 5
    assert res["endpoint"] == "/jobs/batch"


def test_custom_api_retries():
    client = ApiClient()
    res = fetch_user(client, "usr_99", retries=4)
    assert res["retries_allowed"] == 4
    assert res["endpoint"] == "/users/usr_99"
