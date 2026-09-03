"""Hidden tests verifying idempotency key reuse during network timeouts."""
from src.payments import PaymentGatewayTimeout, charge_with_retry


class FlakyGateway:
    def __init__(self, fail_times=1):
        self.fail_times = fail_times
        self.attempts = []

    def charge(self, amount: int, idempotency_key: str):
        self.attempts.append(idempotency_key)
        if len(self.attempts) <= self.fail_times:
            raise PaymentGatewayTimeout("Gateway timed out")
        return {"status": "succeeded", "charge_id": "ch_123", "key": idempotency_key}


def test_retry_reuses_exact_same_idempotency_key():
    gateway = FlakyGateway(fail_times=2)
    result = charge_with_retry(
        gateway=gateway,
        amount=5000,
        customer_id="cust_abc",
        max_retries=3,
    )
    assert result["status"] == "succeeded"
    assert len(gateway.attempts) == 3
    # All 3 attempts MUST share the identical idempotency key!
    first_key = gateway.attempts[0]
    for key in gateway.attempts:
        assert key == first_key, f"Idempotency key changed across retries: {gateway.attempts}"
