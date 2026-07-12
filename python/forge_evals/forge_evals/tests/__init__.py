"""Test suite for the forge_evals package.

Covers (per task spec):
- statistics (bootstrap CI correctness, paired tests, multiple comparisons);
- graders (end-state pass/fail, security graders);
- regression detector;
- promotion gate;
- run record serialization round-trips;
- runners (fake provider, trajectory recorder, harness runner).
"""
