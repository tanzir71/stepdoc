'use client'

import { useEffect } from 'react'

export function ThemeToggle() {
  useEffect(() => {
    const preferred = localStorage.theme === 'dark' || (!localStorage.theme && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', preferred)
  }, [])

  function toggle() {
    const next = !document.documentElement.classList.contains('dark')
    document.documentElement.classList.toggle('dark', next)
    localStorage.theme = next ? 'dark' : 'light'
  }

  return (
    <button className="btn" type="button" onClick={toggle}>
      Toggle theme
    </button>
  )
}
