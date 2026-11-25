export type Theme = 'light' | 'dark' | 'system'
export interface Preferences {
  version: 1
  theme: Theme
  collapsed: boolean
}
export const preferenceKey = 'stepdoc.preferences.v1'
export function readPreferences(): Preferences {
  try {
    const input: unknown = JSON.parse(
      localStorage.getItem(preferenceKey) ?? 'null',
    )
    if (
      input &&
      typeof input === 'object' &&
      'version' in input &&
      input.version === 1 &&
      'theme' in input &&
      ['light', 'dark', 'system'].includes(String(input.theme))
    )
      return {
        version: 1,
        theme: input.theme as Theme,
        collapsed: 'collapsed' in input && input.collapsed === true,
      }
  } catch {
    /* A blocked/corrupt preference store must not block local guides. */
  }
  return { version: 1, theme: 'light', collapsed: false }
}
export function applyPreferences(preferences: Preferences) {
  document.documentElement.dataset.theme =
    preferences.theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : preferences.theme
  try {
    localStorage.setItem(preferenceKey, JSON.stringify(preferences))
  } catch {
    /* Nonessential preferences only. */
  }
}
