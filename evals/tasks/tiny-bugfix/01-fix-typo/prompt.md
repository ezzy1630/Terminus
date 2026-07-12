# Fix the typo in the README

The `src/lib.py` file contains a misspelled word: `recieve`. It should be
`receive`. Fix the typo. Do not refactor any other code.

The acceptance criterion is: the word `recieve` does not appear in
`src/lib.py` after your change, and the word `receive` appears at least
once in the same locations where `recieve` previously appeared.

After your fix, run `pytest -q` to confirm nothing regressed.
