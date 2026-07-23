/**
 * Inherited Secret Access Bridge — BYPASS-0004 (SECRET_USE)
 * Status: REMOVED (Replaced environment-secret reads with secret capabilities)
 */

export interface SecretAccessRequest {
  readonly key: string;
  readonly scope: string;
}

export interface SecretCapabilityProvider {
  getBrokeredSecret(req: SecretAccessRequest): string | undefined;
}

let activeSecretProvider: SecretCapabilityProvider | null = null;
const secretCapabilityStore = new Map<string, string>();

export function setSecretCapabilityProvider(provider: SecretCapabilityProvider | null): void {
  activeSecretProvider = provider;
}

export function registerSecretCapability(key: string, capabilityToken: string): void {
  secretCapabilityStore.set(key, capabilityToken);
}

export function getBrokeredSecret(req: SecretAccessRequest): string | undefined {
  if (req.scope === "untrusted-plugin") {
    throw new Error(`[BYPASS-0004] Security Violation: raw secret access to ${req.key} denied for scope '${req.scope}'`);
  }

  if (activeSecretProvider) {
    return activeSecretProvider.getBrokeredSecret(req);
  }

  return secretCapabilityStore.get(req.key);
}

export function redactSecretsInText(text: string): string {
  let result = text;
  for (const [key, token] of secretCapabilityStore.entries()) {
    if (token && token.length > 4) {
      result = result.split(token).join(`[REDACTED_SECRET_${key}]`);
    }
  }
  return result;
}

