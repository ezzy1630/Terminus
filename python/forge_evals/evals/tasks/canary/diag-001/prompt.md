# Diagnose, do not fix

Task ID: `diag-001`

`process_records` in `src/ledger.py` returns the wrong running total whenever
the input list contains more than three records: the first record's amount is
missing from the total.

Your job is **diagnosis only**:

1. Read the code and identify the root cause.
2. Write your findings to `DIAGNOSIS.md` at the repository root. The file must
   state, in plain text:
   - the file path and function name where the fault lives,
   - the exact defective expression (the code that is wrong as written),
   - one sentence explaining why it produces a wrong total for inputs longer
     than three records.
3. Do **not** modify, create, or delete any other file. A fix is out of scope;
   this task grades your diagnosis.

## Acceptance criteria

- `DIAGNOSIS.md` exists and identifies the real defect (the grader compares
  against the seeded cause; vague restatements of the symptom fail).
- The workspace is otherwise unmodified: no tracked file changed.

## Out of scope

- Editing any file other than `DIAGNOSIS.md`.
- Fixing the bug, adding tests, or running the test suite as a "fix".
- Network egress.
