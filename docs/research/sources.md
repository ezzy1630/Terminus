# Research sources

This document maps the primary sources (SPEC Appendix B) and research interpretation rules (Appendix J.2) that inform Forge's design. Research snapshots used to justify a default MUST be archived by URL, retrieval date, content hash where licensing permits, and a short interpretation note (SPEC Appendix J.4).

## Current primary product and protocol sources

### OpenCode (bootstrap donor, ADR-0002)

- Repository and context architecture:
  - https://github.com/anomalyco/opencode
  - https://github.com/anomalyco/opencode/blob/dev/CONTEXT.md
- Server, SDK, permissions, plugins, MCP, LSP, and skills documentation:
  - https://opencode.ai/docs/server/
  - https://opencode.ai/docs/sdk/
  - https://opencode.ai/docs/permissions/
  - https://opencode.ai/docs/plugins/
  - https://opencode.ai/docs/mcp-servers/
  - https://opencode.ai/docs/lsp/
  - https://opencode.ai/docs/skills/

**Interpretation (Appendix J.2):** OpenCode is a bootstrap donor, not a permanent dependency. Inherited effect paths are tracked in `docs/security/effect-bypass-register.yaml` and removed per the divergence budget.

### OpenAI Codex (runtime/security reference)

- Repository:
  - https://github.com/openai/codex
  - https://github.com/openai/codex/tree/main/codex-rs/app-server
  - https://github.com/openai/codex/tree/main/codex-rs/linux-sandbox
  - https://github.com/openai/codex/tree/main/codex-rs/execpolicy
- Prompt caching and compaction:
  - https://developers.openai.com/api/docs/guides/prompt-caching
  - https://developers.openai.com/api/docs/guides/compaction

**Interpretation:** Codex's typed app-server, bounded queues, generated schemas, Bubblewrap sandbox model, and command policy are reference patterns. Wholesale monorepo fork is rejected (SPEC §4 competitive synthesis).

### Claude Code (UX/skills/sandbox reference)

- Sandbox, subagents, skills, memory, hooks, SDK:
  - https://docs.anthropic.com/en/docs/claude-code/sandboxing
  - https://docs.anthropic.com/en/docs/claude-code/sub-agents
  - https://docs.anthropic.com/en/docs/claude-code/skills
  - https://docs.anthropic.com/en/docs/claude-code/memory
  - https://docs.anthropic.com/en/docs/claude-code/hooks
  - https://docs.anthropic.com/en/docs/claude-code/sdk
  - https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/programmatic-tool-calling

**Interpretation:** Claude Code's scoped subagents, skills progressive disclosure, hooks, and permission modes are useful patterns. Auto-memory and permission prompts are not the security boundary (SPEC §4). Fail closed; add provenance/TTL to memory.

### Anthropic prompt caching / context management

- https://platform.claude.com/docs/en/build-with-claude/prompt-caching

**Interpretation:** Prompt-cache effectiveness depends on stable prefixes (SPEC J.3). Forge enforces immutable epochs (ADR-0010).

### Google Gemini context caching

- https://ai.google.dev/gemini-api/docs/caching

**Interpretation:** Implicit/explicit cache modes as appropriate. Consumed through a tested capability registry (ADR-0022) because APIs change.

### Pi, Oh My Pi, mini-SWE-agent, Aider, OpenHands, Goose, Gemini CLI

- https://github.com/earendil-works/pi
- https://github.com/can1357/oh-my-pi
- https://github.com/SWE-agent/mini-swe-agent
- https://github.com/Aider-AI/aider
- https://github.com/All-Hands-AI/OpenHands
- https://github.com/block/goose
- https://github.com/google-gemini/gemini-cli

**Interpretation:** Each is a reference for specific patterns (Pi: minimal loop; Oh My Pi: ACI lab; mini-SWE-agent: permanent control arm, ADR-0025; Aider: repo-map and edit dialects; OpenHands: meta-harness and remote execution; Goose: Rust extension reference; Gemini CLI: Google-provider reference). Project-reported benchmark numbers are treated as project-reported until reproduced (Appendix J.2).

### MCP stable specification, draft, and security guidance

- https://modelcontextprotocol.io/specification/2025-11-25
- https://modelcontextprotocol.io/specification/draft
- https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices

**Interpretation:** MCP is an interoperability protocol, not a security boundary (SPEC §3.6, ADR-0018). Descriptor pinning, isolation, per-tool scopes, reauthorization.

### Agent Client Protocol v1

- https://agentclientprotocol.com/protocol/v1/overview

**Interpretation:** ACP where supported for external-agent adapters (ADR-0004).

### Agent Skills specification and client implementation guidance

- https://agentskills.io/specification
- https://agentskills.io/client-implementation/adding-skills-support
- https://agentskills.io/skill-creation/evaluating-skills

**Interpretation:** Agent Skills compatibility with Forge manifest extension (ADR-0017). Permission-checked body loading; hash pinning.

### The Token Company

- https://thetokencompany.com/
- https://thetokencompany.com/docs/protect-text
- https://thetokencompany.com/docs/data-retention
- https://thetokencompany.com/benchmarks/financebench
- https://thetokencompany.com/benchmarks/squad-v2
- https://www.ycombinator.com/companies/the-token-company

**Interpretation:** Vendor compression results are treated as vendor-reported until independently reproduced (Appendix J.2). Integrated only behind the experimental privacy gate (ADR-0024). Never compress code/policy/structured state (SPEC §49.6).

## Research papers and engineering work

- **Agentic Harness Engineering:** arXiv:2604.25850
- **Harness-Bench:** arXiv:2605.27922
- **Meta-Harness:** arXiv:2603.28052
- **Toward Executable, Verifiable, and Stateful Agent Systems:** arXiv:2605.18747
- **AgentDojo:** arXiv:2406.13352
- **Less Context, Better Agents:** arXiv:2606.10209
- **Don't Break the Cache:** arXiv:2601.06007
- **SWE-agent:** arXiv:2405.15793
- **Lost in the Middle:** arXiv:2307.03172
- **SWE-bench:** arXiv:2310.06770
- **MemGPT:** arXiv:2310.08560
- **Reflexion:** arXiv:2303.11366
- **Voyager:** arXiv:2305.16291
- **ReAct:** arXiv:2210.03629
- **Toolformer:** arXiv:2302.04761
- **Overeager Coding Agents:** arXiv:2605.18583
- MCP tool-poisoning and distributed-tool-poisoning papers (reviewed in the research trace).
- "Dive into Claude Code" (2026 independent architecture analysis, reviewed in the research trace).

**Interpretation (Appendix J.2):** A paper's result applies directly only to its tested models, tasks, interfaces, and date. Security papers demonstrate plausible attack classes; production controls are validated against concrete Forge threat fixtures.

## Key evidence translated into requirements (Appendix J.3)

| Evidence | Design requirement |
|---|---|
| Long-context position degradation | bounded high-signal working set; authority/recent state placed deliberately |
| Recent complete tool window + summary can outperform full history in a tested workflow | checkpoint/recent-episode policy; no full-history default |
| Prompt-cache effectiveness depends on stable prefixes and provider behavior | immutable epochs and provider-specific renderers |
| SWE-agent ACI ablations show file-view/edit/search feedback matters | ACI treated as first-order, benchmarked subsystem |
| OpenCode typed context sources and epochs provide useful implemented substrate | reuse/bridge rather than greenfield rewrite |
| Codex app-server and Linux sandbox demonstrate typed runtime and OS enforcement patterns | generated protocols, bounded queues, Bubblewrap-class kernel |
| OpenCode plugins can auto-install packages and receive shell access in the upstream model | secure Forge profile isolates installation and removes ambient plugin authority |
| MCP permits powerful tool interoperability while security remains implementation responsibility | descriptor pinning, isolation, per-tool scopes, reauthorization |
| Multi-agent systems can be token intensive and coding work often overlaps | one-agent default and expected-value scheduler |
| Aider repo maps/edit formats show model-specific ACI value | graph-ranked map and edit-dialect experiments |
| External compression can help some natural-language QA but aggressive compression can degrade | allowlisted shadow experiments only; never code/policy by default |

## Additional primary sources to track (Appendix J.4)

- OpenCode `CONTEXT.md` and plugin documentation;
- OpenAI Codex app-server, Linux sandbox, executable policy, and harness-engineering materials;
- Claude Code sandbox, subagent, skill, hook, and memory documentation;
- current Pi and Oh My Pi repositories;
- Omnigent/OpenHands/mini-SWE-agent/Aider repositories;
- MCP stable specification, authorization, and security guidance;
- Agent Skills and ACP specifications;
- provider prompt caching, continuation, and compaction documentation;
- The Token Company protection and retention documentation;
- SWE-bench Verified/Pro, Terminal-Bench, SWE-Lancer, SWE-EVO, and relevant long-horizon benchmarks;
- AgentDojo and newer tool/MCP prompt-injection benchmarks;
- "Lost in the Middle," SWE-agent, "Less Context, Better Agents," and prompt-caching evaluations.

## Research interpretation rules (Appendix J.2)

See `docs/research/interpretation-rules.md`.

## Related

- `docs/research/interpretation-rules.md` — research interpretation rules.
- `docs/decisions/` — ADRs reference these sources.
- SPEC Appendix A (attachment reconciliation), B (source map), J (glossary and research notes).
