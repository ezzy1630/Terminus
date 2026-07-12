# refactor/01-extract-function

Extract a price-formatting helper from a larger function. Exercises the
multi-step edit, the symbol-anchor patch path, and the verification plan
with `parse && diagnostics && narrow_tests && acceptance`. The hidden
tests use AST inspection to verify the refactor is real (no duplicated
formatting logic) rather than a copy-paste extraction.

This task is risk class `normal` because it touches a single file but
changes internal structure; the verification plan therefore includes
`diagnostics`.
