# retrieval-symptom-01

Archetype: Code located from symptoms or behavior.
The prompt mentions no file names, describing only the symptom: customers getting double charged on timeout.
The agent must search across multiple modules to locate `src/payments.py:charge_with_retry`, fix the idempotency key regeneration bug, and record the findings in `DISCOVERY.json`.
Hidden tests verify retry key consistency under mock network timeouts.
