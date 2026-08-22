# Sources and Research Method

## 1. Coverage

This research used Exa to review **470 search results across 15 workstreams**, followed by direct retrieval and filtering of primary sources. It also used the GitHub repository API to inspect Terminus’s complete tree and architecture-critical files.

The 470 figure is the sum of requested search results, not 470 independently quoted sources. Results were deduplicated and filtered; this file lists the high-signal sources that materially informed the design.

Priority order:

1. official documentation and source code;
2. primary research papers;
3. first-party engineering reports;
4. credible practitioner accounts;
5. secondary analysis only when primary evidence was unavailable.

Closed-system conclusions are explicitly limited by public evidence.

## 2. Terminus repository

- Repository: https://github.com/ezzy1630/Terminus
- Existing specification: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/SPEC.md
- README: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/README.md
- Root task runner: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/justfile
- Main CI: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/.github/workflows/ci.yml
- Linux evidence: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/.github/workflows/linux-evidence.yml
- Nightly security: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/.github/workflows/nightly-security.yml
- Release workflow: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/.github/workflows/release.yml
- Effect bypass register: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/docs/security/effect-bypass-register.yaml
- Approval store: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-kernel/src/approvals.rs
- Capability tokens: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-authz/src/token.rs
- Job manager: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-jobs/src/manager.rs
- Process manager: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-process/src/manager.rs
- Secret broker: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-secrets/src/broker.rs
- Egress broker: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-egress/src/broker.rs
- Egress policy: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-egress/src/policy.rs
- Linux sandbox: https://github.com/ezzy1630/Terminus/tree/codex/release-blocker-closure/crates/terminus-sandbox-linux
- macOS sandbox: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-sandbox-macos/src/lib.rs
- Windows sandbox: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-sandbox-windows/src/lib.rs
- Container sandbox: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/crates/terminus-sandbox-container/src/lib.rs
- Codex adapter scaffold: https://github.com/ezzy1630/Terminus/blob/codex/release-blocker-closure/adapters/codex/runner.ts
- Evaluation package: https://github.com/ezzy1630/Terminus/tree/codex/release-blocker-closure/python/forge_evals

## 3. Major harnesses and official documentation

### OpenAI Codex

- Codex repository: https://github.com/openai/codex
- Codex documentation: https://developers.openai.com/codex/
- Codex app/server protocol and source material are available in the repository and official documentation.

### Anthropic Claude Code

- Claude Code documentation: https://docs.anthropic.com/en/docs/claude-code/overview
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks
- Claude Code subagents: https://docs.anthropic.com/en/docs/claude-code/sub-agents
- Claude Code sandboxing: https://docs.anthropic.com/en/docs/claude-code/security
- Claude Agent SDK: https://docs.anthropic.com/en/docs/claude-code/sdk

### OpenCode

- Documentation: https://opencode.ai/docs/
- Server: https://opencode.ai/docs/server/
- Source: https://github.com/sst/opencode

### Pi / Oh My Pi

- Pi coding agent: https://github.com/badlogic/pi-mono
- Oh My Pi: https://github.com/can1357/oh-my-pi

### Aider

- Documentation: https://aider.chat/docs/
- Repository map: https://aider.chat/docs/repomap.html
- Edit formats: https://aider.chat/docs/more/edit-formats.html
- Source: https://github.com/Aider-AI/aider

### OpenHands

- Documentation: https://docs.openhands.dev/
- Source: https://github.com/All-Hands-AI/OpenHands

### SWE-agent and mini-SWE-agent

- SWE-agent: https://github.com/SWE-agent/SWE-agent
- SWE-agent paper: https://arxiv.org/abs/2405.15793
- mini-SWE-agent: https://github.com/SWE-agent/mini-swe-agent

### Goose

- Source: https://github.com/block/goose
- Documentation: https://block.github.io/goose/

### Cline and Roo Code

- Cline: https://github.com/cline/cline
- Cline SDK: https://github.com/cline/cline-sdk
- Roo Code: https://github.com/RooCodeInc/Roo-Code

### GitHub Copilot coding agent

- Official documentation: https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
- Custom agents: https://docs.github.com/en/copilot/customizing-copilot/creating-custom-agents-for-copilot-coding-agent

### Kiro

- Product/documentation: https://kiro.dev/
- CLI documentation: https://kiro.dev/docs/cli/
- ACP: https://agentclientprotocol.com/

### Other commercial systems

- Cursor: https://www.cursor.com/
- Devin: https://devin.ai/
- Amp: https://ampcode.com/
- Factory: https://www.factory.ai/

Because implementations are closed, architecture claims for these systems rely on first-party engineering posts, documentation and observed product behavior rather than source verification.

## 4. Production engineering systems

- Stripe engineering: https://stripe.com/blog
- Ramp engineering: https://engineering.ramp.com/
- Shopify engineering: https://shopify.engineering/
- Cursor engineering/blog: https://www.cursor.com/blog
- GitHub engineering/blog: https://github.blog/
- Factory research/blog: https://www.factory.ai/news

The research specifically searched for Minions, Inspect, River/Aquifer, background-agent durability, devboxes, prewarmed environments, workflow state, validation and production learning loops.

## 5. NVIDIA

- AVO announcement: https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/
- Original linked X post: https://x.com/NVIDIAAI/status/2090786258981466231
- Agent harness capabilities: https://developer.nvidia.com/blog/six-agent-harness-capabilities-for-higher-model-performance/
- Security in an agent stack: https://developer.nvidia.com/blog/where-security-fits-in-an-ai-agent-stack/
- NemoClaw: https://github.com/NVIDIA/NemoClaw
- OpenShell: https://github.com/NVIDIA/OpenShell
- NOOA (a separate NVIDIA project, not the linked AVO post): https://github.com/NVIDIA/NOOA

## 6. Harness optimization and self-improvement

- Agentic Harness Engineering: https://arxiv.org/html/2604.25850v2
- Meta-Harness: https://arxiv.org/html/2603.28052
- HarnessCompass: https://arxiv.org/html/2608.01918
- VeRO: https://arxiv.org/html/2602.22480
- HarnessOpt-Bench: https://arxiv.org/html/2608.06301
- HARNESSFIX: https://arxiv.org/html/2606.06324
- Harness-R1: https://arxiv.org/html/2608.02276
- Co-Harness: https://arxiv.org/html/2607.22688
- HarnessX: https://arxiv.org/html/2606.14249
- Google agent quality flywheel: https://developers.googleblog.com/driving-the-agent-quality-flywheel-from-your-coding-agent/
- LangChain trace improvement loop: https://www.langchain.com/blog/traces-start-agent-improvement-loop
- LangChain continual learning: https://www.langchain.com/blog/continual-learning-for-ai-agents

Reported paper gains are treated as author-reported until independently reproduced.

## 7. Workflow compilation and formal verification

- COVENANT: https://arxiv.org/html/2607.25400v1
- SIGIL: https://arxiv.org/html/2607.27309
- Agentproof: https://arxiv.org/html/2603.20356
- Lean4Agent: https://arxiv.org/html/2606.06523v2
- POLARIS: https://arxiv.org/html/2601.11816
- PlanCompiler: https://arxiv.org/html/2604.13092
- Non-Turing-complete policy compilation: https://arxiv.org/abs/2603.27299v1

These sources support typed workflow IR, deterministic traversal, structural/temporal checks, model-owned judgment slots and runtime monitoring.

## 8. Durable execution, effects and recovery

- Verified Tool Calls Improve Reliability Under Non-Atomic Failures: https://arxiv.org/html/2608.02645
- Cordon: https://arxiv.org/html/2606.17573
- Atomix: https://arxiv.org/html/2602.14849
- Mnemosyne: https://arxiv.org/html/2607.00269v2
- CapLease: https://arxiv.org/html/2608.01710
- Resume Means Resume: https://arxiv.org/abs/2608.03836v1
- AgentRewind: https://arxiv.org/pdf/2608.14380
- AstronOS: https://arxiv.org/html/2608.16381
- Google AX: https://github.com/google/ax
- Agent Substrate: https://github.com/agent-substrate/substrate
- AgentENV: https://github.com/kvcache-ai/AgentENV
- Temporal durable execution documentation: https://docs.temporal.io/

## 9. Security, prompt injection and credential isolation

- Model Context Protocol security guidance: https://modelcontextprotocol.io/specification/
- NVIDIA agent-stack security: https://developer.nvidia.com/blog/where-security-fits-in-an-ai-agent-stack/
- Docker Sandboxes: https://docs.docker.com/ai/sandboxes/
- AWS secure agent guidance: https://aws.amazon.com/blogs/security/
- Microsoft AI security research: https://www.microsoft.com/en-us/security/blog/topic/ai-security/
- Prompt injection and agent-security research was searched under StepJack, LoginTrap, LivePI, GitInject, skill poisoning, MCP tool poisoning, browser indirect injection and computer-use security.
- OWASP Top 10 for LLM Applications: https://owasp.org/www-project-top-10-for-large-language-model-applications/
- NIST AI Risk Management Framework: https://www.nist.gov/itl/ai-risk-management-framework

## 10. Context, memory and repository intelligence

The research reviewed recent primary work on:

- codebase retrieval and graph-based context;
- repository structure/AST/symbol indexing;
- long-context degradation;
- semantic compaction;
- episodic/semantic/procedural memory;
- memory provenance and contradiction;
- cache-aware prompt construction;
- code-as-action and pass-by-reference agent architectures.

Named sources included CodeNib, Agent Retrieval Bench, LARGER/CodeAnchor, CODESTRUCT, FastContext, CodeMEM, MemGym, AMA, EvoMemBench, Ground Truth First, PRO-LONG, MemQ, TokenPilot, NOOA, CaveAgent and LLM-as-Code. Several are 2026 preprints; design conclusions were used only where multiple sources converged.

## 11. Human oversight and operator experience

- Human oversight practice: https://doi.org/10.48550/arxiv.2606.05391
- Coding with Enemy: https://arxiv.org/html/2606.05647
- Trust-calibrated review: https://arxiv.org/html/2606.01969
- Delegation contracts: https://arxiv.org/html/2606.17099
- AgentGUI: https://arxiv.org/html/2607.26300
- LEDGER: https://arxiv.org/html/2608.18398
- HANSEL: https://arxiv.org/html/2606.18671v1
- JarvisBench: https://arxiv.org/html/2608.14870
- Causal Agent Replay: https://arxiv.org/html/2606.08275
- Hedwig: https://arxiv.org/html/2605.11495
- Configurable assistants: https://arxiv.org/html/2607.09215
- Collaborative planning: https://arxiv.org/html/2605.23023v1
- Vibe coding guidance: https://arxiv.org/html/2602.10473v1
- Multi-agent coordination: https://arxiv.org/html/2608.16801
- (Im)Paired Programming: https://arxiv.org/pdf/2607.26375

## 12. Interoperability standards

- Model Context Protocol: https://modelcontextprotocol.io/
- Agent Client Protocol: https://agentclientprotocol.com/
- Google A2A: https://github.com/a2aproject/A2A
- AG-UI: https://github.com/ag-ui-protocol/ag-ui
- A2UI: https://a2ui.org/
- Agent Trace Interchange Format work: searched as ATIF and agent trace interchange specifications.

## 13. Coding-agent evaluation

- SWE-bench: https://www.swebench.com/
- SWE-bench repository: https://github.com/SWE-bench/SWE-bench
- Terminal-Bench: https://www.tbench.ai/
- AgentBench: https://github.com/THUDM/AgentBench
- WebArena: https://webarena.dev/
- BrowserGym: https://github.com/ServiceNow/BrowserGym
- OSWorld: https://os-world.github.io/
- ARC-AGI: https://arcprize.org/

The research also reviewed 2026 work under Harness-Bench, Scaffold Effect, Binding Constraint, HarnessOpt-Bench and benchmark-contamination/task-defect analyses. Public leaderboards were not treated as controlled proof of harness quality.

## 14. Source-quality caveats

- Vendor benchmark claims may use private models, hidden tools or incomparable budgets.
- Public benchmarks can be contaminated, defective or overfit.
- A first-party architecture post explains design intent but does not independently verify reliability.
- Preprints can be valuable and current, but reported gains remain provisional.
- A repository’s tests and file counts are not current release evidence without a passing run for the exact commit.
- Closed products may be stronger or weaker than public evidence indicates; `Unknown` is preferable to invented certainty.
