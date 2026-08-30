/**
 * The settings categories, as ids only.
 *
 * `App.tsx` needs the id list to resolve a requested category (⌘, "shortcuts",
 * a "providers" alias) before Settings has loaded. Importing that from
 * `Settings.tsx` pulled the whole settings bundle into the shell's first paint,
 * which is exactly what its `React.lazy` boundary exists to prevent.
 */
export const SETTING_CATEGORY_IDS = ["appearance", "accounts", "models", "shortcuts", "advanced"] as const;
export type SettingCategoryId = (typeof SETTING_CATEGORY_IDS)[number];

export function isSettingCategoryId(value: string): value is SettingCategoryId {
  return (SETTING_CATEGORY_IDS as readonly string[]).includes(value);
}
