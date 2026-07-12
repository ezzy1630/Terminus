# tiny-bugfix/02-null-check

Add a null-check to a single function. Slightly harder than 01-fix-typo
because the fix requires understanding the failure mode and writing the
right guard. Exercises the same harness components (patch, test-run,
verification plan) plus the model's ability to handle edge cases without
changing the function signature.

The hidden tests under `hidden/` cover the three null-input cases the
prompt mentions; the agent does not see them.
