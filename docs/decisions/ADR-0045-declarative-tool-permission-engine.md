# ADR-0045: Declarative tool permission engine in the control plane

- **Status:** ADOPTED
- **Date:** 2026-08-26
- **Decision owner:** security owner
- **Supersedes:** none
- **Related:** SPEC §13, §31, §36.11; ADR-0012; ADR-0035

## Context

Tool execution today is gated by two kernel mechanisms: the strictest-wins
command policy (`terminus-policy`) and capability-bound approvals
(`terminus-authz` + `crates/terminus-kernel/src/approvals.rs`). Both are
coarse for interactive use: there is no way to declare, per agent or per
session, that `git *` is allowed while `git push*` asks and `rm -rf *` is
denied — with the decision remembered for the session so the user answers
once.

Field-proven harnesses (OpenCode, Codex approval modes, Hermes command
approval) converge on a small declarative surface: ordered glob rules per
tool evaluating to allow | ask | deny, last match wins, plus remembered
interactive grants. The matching logic is pure and tiny; the risk lives in
wiring it to real effects.

## Decision

1. Adopt a declarative permission layer as a **pure evaluation engine** in
   `packages/permissions`: rules `{tool, pattern, action, origin}`,
   evaluated last-match-wins against an opaque subject string (command line
   for exec-like tools, workspace target path for file tools).
2. **Fail closed**: when no rule matches, the default action is `ask`.
   Callers may configure a looser default explicitly; the library never
   defaults to silent allow.
3. Pattern semantics: `*`/`**` match any character sequence including `/`
   because subjects are command lines, not paths. All other characters are
   literal.
4. Rule sets merge by concatenation (agent scope first, session scope
   second); later scopes refine earlier ones under last-match-wins.
5. Interactive grants are remembered through an injected `ApprovalMemory`
   port: `always` grants persist within their scope; `once` grants are
   consumed by the first evaluation they admit.
6. Denials render a structured envelope carrying the deciding rule and an
   optional user-supplied correction, enabling deny-with-correction flows.
7. **Enforcement stays at the boundary.** This engine never executes or
   authorizes anything by itself. The control plane consults it before
   settling a tool call: `deny` short-circuits with the structured denial,
   `ask` routes through the existing kernel approval flow
   (SPEC §36.11), `allow` proceeds to normal policy + capability checks.
   Kernel-side strictest-wins policy remains authoritative and is NOT
   weakened; this layer can only make decisions stricter in practice.

## Alternatives

- **Extend `terminus-policy` (Rust) with glob rules.** Rejected for now:
  the kernel policy is a security component with adversarial tests and fuzz
  targets; bolting interactive UX semantics onto it couples approval flow to
  the TCB. Revisit only if kernel-side enforcement of these rules is ever
  required.
- **Per-tool hardcoded heuristics.** Rejected: opaque, not auditable, does
  not compose across agents/sessions.

## Consequences

- `packages/permissions` is pure logic with unit tests covering ordering,
  wildcard edge cases, memory durability, and config decoding.
- Control-plane wiring must map `ask` onto durable kernel approvals and
  record both rule hits and remembered grants in audit events.
- Permission decisions are advisory-to-allow only: they cannot bypass
  kernel policy, sandboxing, or capability tokens.
