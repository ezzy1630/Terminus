# Research interpretation rules (SPEC Appendix J.2)

This document specifies how Terminus interprets research and vendor claims. The normative source is SPEC Appendix J.2; this document is a summary for contributors and decision-makers.

## Rules

1. **A paper's result applies directly only to its tested models, tasks, interfaces, and date.** Do not generalize a 2024 result on GPT-4 to a 2026 result on a different model without re-evaluation.

2. **Project README benchmark numbers are treated as project-reported until reproduced.** A coding-agent project claiming 70% on SWE-bench Verified is a hypothesis, not a fact, until Terminus's eval lab reproduces it (or fails to).

3. **Vendor compression results are treated as vendor-reported until independently reproduced.** The Token Company's benchmarks (Appendix B) are vendor-reported. Terminus's shadow-mode harness (ADR-0024) independently evaluates compression.

4. **Provider caching and continuation behavior is consumed through a tested capability registry** because APIs and models change. The router (ADR-0022) reads from a pinned capability snapshot, not the live provider API.

5. **Security papers demonstrate plausible attack classes; production controls are validated against concrete Terminus threat fixtures.** A paper showing MCP tool poisoning is a warning; Terminus's `evals/security/mcp-poisoning.yaml` is the validation.

6. **The specification prefers primary papers, official repositories, and official documentation over summaries.** When in doubt, cite the primary source.

## Key evidence → requirements (Appendix J.3)

| Evidence | Design requirement |
|---|---|
| Long-context position degradation (Lost in the Middle) | Bounded high-signal working set; authority/recent state placed deliberately. |
| Recent complete tool window + summary can outperform full history | Checkpoint/recent-episode policy; no full-history default (ADR-0011). |
| Prompt-cache effectiveness depends on stable prefixes | Immutable epochs and provider-specific renderers (ADR-0010). |
| SWE-agent ACI ablations show file-view/edit/search feedback matters | ACI treated as first-order, benchmarked subsystem (ADR-0012). |
| OpenCode typed context sources and epochs provide useful research evidence | Implement the useful behavior behind Terminus-owned Context IR and epoch contracts (ADR-0039). |
| Codex app-server and Linux sandbox demonstrate typed runtime and OS enforcement patterns | Generated protocols, bounded queues, Bubblewrap-class kernel (ADR-0014). |
| OpenCode plugins can auto-install packages and receive shell access in the upstream model | Secure Terminus profile isolates installation and removes ambient plugin authority (ADR-0019). |
| MCP permits powerful tool interoperability while security remains implementation responsibility | Descriptor pinning, isolation, per-tool scopes, reauthorization (ADR-0018). |
| Multi-agent systems can be token intensive and coding work often overlaps | One-agent default and expected-value scheduler (ADR-0020). |
| Aider repo maps/edit formats show model-specific ACI value | Graph-ranked map and edit-dialect experiments (ADR-0012). |
| External compression can help some natural-language QA but aggressive compression can degrade | Allowlisted shadow experiments only; never code/policy by default (ADR-0024). |

## Archive requirements (Appendix J.4)

Research snapshots used to justify a default MUST be archived by:

- **URL** — the source URL.
- **Retrieval date** — when the snapshot was taken.
- **Content hash** — sha256 of the archived content (where licensing permits).
- **Interpretation note** — a short note explaining how the evidence maps to a Terminus requirement.

This ensures that if a source changes or disappears, the original evidence is preserved.

## Applying research to Terminus

When proposing a default feature (ADR-0025 promotion gate):

1. Cite the primary source (paper, repo, docs).
2. Note the retrieval date and content hash.
3. State the interpretation: what does this evidence imply for Terminus?
4. State the cohort and metric that will validate the implication.
5. State the guardrails (what would cause the feature to be demoted).
6. Run the eval; archive the result.
7. The promotion gate (SPEC §18.7, §41.12) decides: promote, keep EXPERIMENTAL, or REJECT.

## What research does NOT do

- Research does not replace Terminus's eval lab. A paper showing X works on model M does not mean X works on Terminus's cohorts with Terminus's models.
- Research does not justify a default without a promotion gate (SPEC §26.3 #10).
- Research does not override a non-negotiable invariant (SPEC §26.3). If a paper suggests a feature that violates an invariant, the invariant wins.
- Research does not excuse bypassing the kernel. A "the model can do X" claim does not authorize X without kernel enforcement.

## Related

- `docs/research/sources.md` — the source map.
- `docs/decisions/` — ADRs reference these rules.
- `docs/architecture/evaluation-lab.md` — the eval lab.
- SPEC Appendix B (source map), J (glossary and research notes).
