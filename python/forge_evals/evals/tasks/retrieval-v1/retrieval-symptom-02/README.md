# retrieval-symptom-02

Archetype: Code located from symptoms or behavior.
The prompt mentions no file names, only the ValueError traceback during batch parsing.
The agent must search through server, database, exporter, and parser files to locate `src/batch_parser.py`, fix blank line and comment skipping, and keep the changes confined to that file.
Hidden tests verify multiple empty lines, whitespace-only lines, comment headers, and trailing blanks.
