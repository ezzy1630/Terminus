/**
 * Inherited Plugin Hook Bridge — BYPASS-0005 (PLUGIN_ADMIN)
 * Status: REMOVED (Moved inherited plugins out-of-process into worker IPC host)
 *
 * Third-party / unverified plugins MUST have an OutOfProcessPluginHost.
 * In-process fallback is denied (no ambient effects).
 */

export interface LegacyPluginHook {
  readonly name: string;
  readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface OutOfProcessPluginHost {
  invokeHook(pluginName: string, hookName: string, args: Record<string, unknown>): Promise<unknown>;
}

let activePluginHost: OutOfProcessPluginHost | null = null;

export function setOutOfProcessPluginHost(host: OutOfProcessPluginHost | null): void {
  activePluginHost = host;
}

export function wrapLegacyPluginHook(
  pluginName: string,
  hook: LegacyPluginHook,
  opts?: { readonly allowInProcess?: boolean },
): LegacyPluginHook {
  return {
    name: hook.name,
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      if (args.__raw_process__ || args.__raw_fs__) {
        throw new Error(
          `[BYPASS-0005] Security Violation: plugin '${pluginName}' requested ambient authority access`,
        );
      }

      if (activePluginHost) {
        return activePluginHost.invokeHook(pluginName, hook.name, args);
      }

      if (opts?.allowInProcess === true) {
        const sanitizedArgs = JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
        return hook.execute(sanitizedArgs);
      }

      throw new Error(
        `[BYPASS-0005] plugin '${pluginName}' denied: out-of-process host required (no ambient in-process execution)`,
      );
    },
  };
}
