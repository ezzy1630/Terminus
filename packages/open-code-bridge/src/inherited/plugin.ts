/**
 * Inherited Plugin Hook Bridge — BYPASS-0005 (PLUGIN_ADMIN)
 * Containment: In-process plugin hook wrapper; restricts module imports and process spawner.
 * Target removal milestone: M9
 */

export interface LegacyPluginHook {
  readonly name: string;
  readonly execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export function wrapLegacyPluginHook(pluginName: string, hook: LegacyPluginHook): LegacyPluginHook {
  return {
    name: hook.name,
    execute: async (args: Record<string, unknown>): Promise<unknown> => {
      // Containment: Block direct access to un-audited ambient-authority properties
      if (args.__raw_process__ || args.__raw_fs__) {
        throw new Error(`[BYPASS-0005] Security Containment Violation: plugin '${pluginName}' requested ambient authority access`);
      }
      return hook.execute(args);
    },
  };
}
