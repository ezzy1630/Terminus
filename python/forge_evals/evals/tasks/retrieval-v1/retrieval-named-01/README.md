# retrieval-named-01

Archetype: Named file bug fix.
The prompt mentions `src/shipping.py` by name. The agent must update the free shipping threshold check from `> 5000` to `>= 7500`.
Hidden tests verify threshold boundary values (5000, 7499, 7500, 7501).
