/**
 * Secret and private-data filtering for memory candidates (SPEC §39.4, §39.8).
 *
 * Rejects or redacts statements that look like credentials, PII, or
 * confidential transient data before any claim is persisted.
 */
import { ValidationError } from "@terminus/domain";

export type PrivacyDisposition =
  | { readonly kind: "allow"; readonly statement: string }
  | { readonly kind: "redact"; readonly statement: string; readonly reason: string }
  | { readonly kind: "reject"; readonly reason: string };

/** Compiled literal / regex patterns that indicate secret-adjacent content. */
export interface PrivacyPattern {
  readonly id: string;
  readonly description: string;
  readonly match: RegExp;
  readonly disposition: "reject" | "redact";
}

const DEFAULT_PATTERNS: readonly PrivacyPattern[] = [
  {
    id: "aws_access_key",
    description: "AWS access key id",
    match: /\bAKIA[0-9A-Z]{16}\b/,
    disposition: "reject",
  },
  {
    id: "github_pat",
    description: "GitHub personal access token",
    match: /\bghp_[A-Za-z0-9]{20,}\b/,
    disposition: "reject",
  },
  {
    id: "github_oauth",
    description: "GitHub OAuth token",
    match: /\bgho_[A-Za-z0-9]{20,}\b/,
    disposition: "reject",
  },
  {
    id: "openai_key",
    description: "OpenAI-style API key",
    match: /\bsk-[A-Za-z0-9]{20,}\b/,
    disposition: "reject",
  },
  {
    id: "bearer_token",
    description: "Bearer authorization token",
    match: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/i,
    disposition: "reject",
  },
  {
    id: "private_key_block",
    description: "PEM private key block",
    match: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    disposition: "reject",
  },
  {
    id: "password_assignment",
    description: "password / secret assignment",
    match: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S+/i,
    disposition: "reject",
  },
  {
    id: "email_address",
    description: "email address (PII)",
    match: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    disposition: "redact",
  },
  {
    id: "ssn_like",
    description: "US SSN-like number",
    match: /\b\d{3}-\d{2}-\d{4}\b/,
    disposition: "reject",
  },
];

export interface PrivacyFilter {
  readonly patterns: readonly PrivacyPattern[];
}

export function defaultPrivacyFilter(): PrivacyFilter {
  return { patterns: DEFAULT_PATTERNS };
}

/**
 * Classify a candidate statement. Rejection is preferred over redaction for
 * credentials; redaction is used only for lower-sensitivity PII that can be
 * stripped while preserving the claim.
 */
export function filterPrivateData(
  statement: string,
  filter: PrivacyFilter = defaultPrivacyFilter(),
): PrivacyDisposition {
  const trimmed = statement.trim();
  if (trimmed.length === 0) {
    return { kind: "reject", reason: "empty statement" };
  }

  let working = trimmed;
  for (const pattern of filter.patterns) {
    if (!pattern.match.test(working)) continue;
    if (pattern.disposition === "reject") {
      return {
        kind: "reject",
        reason: `matches privacy pattern '${pattern.id}' (${pattern.description})`,
      };
    }
    working = working.replace(pattern.match, `[REDACTED:${pattern.id}]`);
  }

  if (working !== trimmed) {
    return {
      kind: "redact",
      statement: working,
      reason: "redacted PII before storage",
    };
  }
  return { kind: "allow", statement: trimmed };
}

/** Throw when a statement must not be stored. */
export function assertStorableStatement(
  statement: string,
  filter: PrivacyFilter = defaultPrivacyFilter(),
): string {
  const result = filterPrivateData(statement, filter);
  switch (result.kind) {
    case "allow":
      return result.statement;
    case "redact":
      return result.statement;
    case "reject":
      throw new ValidationError("memory candidate rejected by privacy filter", {
        reason: result.reason,
      });
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}

/** True when the statement contains any secret/PII pattern. */
export function containsPrivateData(
  statement: string,
  filter: PrivacyFilter = defaultPrivacyFilter(),
): boolean {
  return filterPrivateData(statement, filter).kind !== "allow";
}
