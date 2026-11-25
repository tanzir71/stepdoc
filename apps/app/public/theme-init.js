try {
  const value = JSON.parse(
    localStorage.getItem('stepdoc.preferences.v1') || 'null',
  )
  const theme =
    value?.version === 1 && ['light', 'dark', 'system'].includes(value.theme)
      ? value.theme
      : 'light'
  document.documentElement.dataset.theme =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme
} catch {
  document.documentElement.dataset.theme = 'light'
}
