/**
 * Explicit Extension Lockfile Validator (SPEC §27.5, §42.2).
 *
 * Enforces integrity verification for installed extensions via extension-lock.json.
 * Disables automatic plugin installation when secure_mode is enabled.
 */

export interface ExtensionLockEntry {
  readonly id: string;
  readonly version: string;
  readonly integrity: string; // sha256 checksum
  readonly scope: string;
}

export interface ExtensionLockfile {
  readonly version: 1;
  readonly extensions: Record<string, ExtensionLockEntry>;
}

export class ExtensionLockfileValidator {
  private readonly lockfile: ExtensionLockfile;
  private readonly secureMode: boolean;

  constructor(lockfile: ExtensionLockfile, options: { secureMode?: boolean } = {}) {
    this.lockfile = lockfile;
    this.secureMode = options.secureMode ?? true;
  }

  /**
   * Validate an extension against the lockfile.
   */
  validateExtension(id: string, version: string, calculatedIntegrity: string): boolean {
    const entry = this.lockfile.extensions[id];
    if (!entry) {
      if (this.secureMode) {
        throw new Error(`[ExtensionLockfile] Secure Mode Violation: extension '${id}' is not in extension-lock.json`);
      }
      return false;
    }

    if (entry.version !== version) {
      throw new Error(
        `[ExtensionLockfile] Version mismatch for '${id}': lockfile specifies ${entry.version}, got ${version}`
      );
    }

    if (entry.integrity !== calculatedIntegrity) {
      throw new Error(
        `[ExtensionLockfile] Integrity failure for '${id}': expected ${entry.integrity}, got ${calculatedIntegrity}`
      );
    }

    return true;
  }

  /**
   * Check whether automatic plugin installation is permitted.
   */
  canAutoInstallPlugin(pluginId: string): boolean {
    if (this.secureMode) {
      // Automatic plugin installation is strictly disabled in secure mode
      return false;
    }
    return Boolean(this.lockfile.extensions[pluginId]);
  }
}
