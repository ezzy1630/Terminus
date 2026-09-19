We are adding configurable retry support to our internal HTTP client.

In `src/client.py`:
1. Update `ApiClient.request(self, endpoint: str, method: str = "GET", retry_count: int = 3) -> dict`:
   - Accept an optional `retry_count: int = 3` parameter.
   - If `retry_count < 0`, raise `ValueError("retry_count must be non-negative")`.
   - Record `retry_count` in the returned response dictionary under the key `"retries_allowed"`.

2. Propagate this update to all callers across the repository:
   - In `src/api.py`: update `fetch_user(client: ApiClient, user_id: str, retries: int = 2)` to pass `retry_count=retries`.
   - In `src/cli.py`: update `run_sync(client: ApiClient, retries: int = 1)` to pass `retry_count=retries`.
   - In `src/scheduler.py`: update `dispatch_batch_job(client: ApiClient)` to pass `retry_count=5`.

3. Ensure all call sites and the client are updated consistently.
4. Verify all tests pass with `python -m pytest -q`.
5. Only modify `src/client.py`, `src/api.py`, `src/cli.py`, and `src/scheduler.py`. Do not modify tests or other files.
