Our backend data processing service is failing on imported batch files with the following traceback:

```text
Traceback (most recent call last):
  ...
ValueError: invalid literal for int() with base 10: ''
```

Customers often leave trailing blank lines, empty whitespace lines, or comment lines starting with `#` in their batch upload files.

Please diagnose the codebase to find where batch input is parsed, and update the parser to:
1. Strip leading and trailing whitespace from each line.
2. Ignore empty or blank lines.
3. Ignore comment lines where the first non-whitespace character is `#`.
4. Successfully parse valid integer ID and quantity columns.
5. Ensure only the responsible parser file is modified.
6. Verify all tests pass with `python -m pytest -q`.
