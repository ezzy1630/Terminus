Customer support has escalated an urgent issue:
"Customers report getting double-charged whenever an initial payment attempt experiences a network timeout."

Investigate the codebase to diagnose and resolve this bug:
1. Locate where payment retries are implemented.
2. Determine why a network timeout causes a double charge rather than an idempotent retry.
3. Fix the retry mechanism so that retried charge attempts reuse the original idempotency key rather than creating a new one.
4. Create a file named `DISCOVERY.json` in the root of the repository with the following JSON schema:
   ```json
   {
     "offending_file": "relative/path/to/file.py",
     "function_name": "name_of_function",
     "root_cause": "description of why the bug occurred"
   }
   ```
5. Ensure all existing and new tests pass with `python -m pytest -q`.
