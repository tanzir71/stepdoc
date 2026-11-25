import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@stepdoc/ui/styles.css'
import './styles.css'
import { App } from './App'
import { ActivityProvider } from './activity'
import { applyPreferences, readPreferences } from './preferences'
applyPreferences(readPreferences())
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ActivityProvider>
      <App />
    </ActivityProvider>
  </StrictMode>,
)
