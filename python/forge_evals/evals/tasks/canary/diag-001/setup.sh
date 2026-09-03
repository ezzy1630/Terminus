#!/bin/bash
set -euo pipefail
mkdir -p src
cat > .gitignore <<'EOF'
__pycache__/
.pytest_cache/
EOF
mkdir -p hidden
cp "$TERMINUS_TASK_DIR/hidden/test_hidden.py" hidden/test_hidden.py
touch src/__init__.py
cat > src/ledger.py <<'PY'
"""Record ledger with a seeded defect (diagnosis target, do not fix)."""


def process_records(records):
    """Return (running_total, per_record_balances) for the given records.

    The first record's amount is missing from the running total whenever the
    input has more than three records: ``records[1:]`` skips it. Diagnose;
    do not fix.
    """
    running_total = 0
    balances = []
    for record in (records[1:] if len(records) > 3 else records):
        running_total += record.get("amount", 0)
        balances.append(running_total)
    return running_total, balances
PY
cat > justfile <<'JUST'
check-readonly:
    @git status --porcelain
JUST
