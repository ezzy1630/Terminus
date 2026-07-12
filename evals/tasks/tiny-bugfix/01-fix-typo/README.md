# tiny-bugfix/01-fix-typo

A trivial typo fix in a single Python file. Used as the smallest possible
end-to-end smoke task for the Forge harness: the agent must read a file,
apply a single-line edit, run tests, and declare completion. The task
exercises the patch transaction, the test-run skill, and the verification
plan with `parse && narrow_tests && acceptance`.

The hidden test under `hidden/` is NEVER projected into the model context;
it is run by the grader after the agent declares the task complete.
