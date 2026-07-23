/**
 * Inherited Secret Access Bridge — BYPASS-0004 (SECRET_USE)
 * Containment: Brokered credential lookup; prevents raw environment leakage.
 * Target removal milestone: M4
 */

export interface SecretAccessRequest {
  readonly key: string;
  readonly scope: string;
}

export function getBrokeredSecret(req: SecretAccessRequest): string | undefined {
  const envVal = process.env[req.key];
  if (!envVal) {
    return undefined;
  }

  // Containment: Audit secret access call
  if (req.scope === "untrusted-plugin") {
    throw new Error(`[BYPASS-0004] Security Containment Violation: raw secret access to ${req.key} denied for scope '${req.scope}'`);
  }

  return envVal;
}

export function redactSecretsInText(text: string): string {
  let result = text;
  const secretKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN"];
  for (const k of secretKeys) {
    const val = process.env[k];
    if (val && val.length > 4) {
      result = result.split(val).join(`[REDACTED_${k}]`);
    }
  }
  return result;
}
