# Find the double-charge

Task ID: `repo-discovery-001`

Support reports that during payment-provider outages, a small number of
customers were **charged twice** for one order. The initial report contains
no file names and no stack traces — only the symptom above. This repository
contains several services; only you can find where the fault lives.

Investigate the repository and write your findings to `DISCOVERY.json` at the
repository root with exactly these keys:

```json
{
  "module_path": "<relative path of the file that performs the charge>",
  "entry_symbol": "<name of the function that performs the charge with retry>",
  "retry_count": <how many total charge attempts the code makes when the provider times out>,
  "root_cause": "<one short phrase naming why a retry charges twice>"
}
```

Ground rules for the values:

- `module_path` is the repository-relative path, e.g. `pkg/src/file.py`.
- `entry_symbol` is the exact function name as written in the code.
- `retry_count` is the integer number of attempts the retry loop performs
  when every attempt times out (count every try, including the first).
- `root_cause` must name the mechanism, e.g. the missing guard that would
  make the retry safe.

Do **not** modify, create, or delete any file other than `DISCOVERY.json`.
This task grades discovery, not a fix.

## Acceptance criteria

- `DISCOVERY.json` exists with the four keys and correct ground-truth values.
- The workspace is otherwise unmodified.

## Out of scope

- Editing any tracked file.
- Fixing the bug or adding tests.
- Network egress.
