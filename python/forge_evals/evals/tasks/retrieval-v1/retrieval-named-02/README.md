# retrieval-named-02

Archetype: Named file bug fix.
The prompt mentions `src/ledger.py` by name. The agent must update `calculate_balance` so that transactions of type `"refund"` add to the balance rather than subtract from it.
Hidden tests verify multiple refunds, mixed debits and deposits, and empty transaction lists.
