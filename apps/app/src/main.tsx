import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@stepdoc/ui/styles.css'
import './styles.css'
import { HostedApp } from './HostedApp'
import { ActivityProvider } from './activity'
import { applyPreferences, readPreferences } from './preferences'
applyPreferences(readPreferences())
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ActivityProvider>
      <HostedApp />
    </ActivityProvider>
  </StrictMode>,
)
