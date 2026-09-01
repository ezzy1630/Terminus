# test-repair-001 — failing-test repair canary

`slugify` ships with accent handling and separator-collapsing defects; the
public suite fails at start and is the specification. Hidden cases pin
umlaut transliteration, number retention, and empty inputs. Grader is
deterministic: pytest plus a scope check that tests/ stayed untouched.
