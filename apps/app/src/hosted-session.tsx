import { createContext, useContext } from 'react'
import type { ApiSession, ApiHealth } from '@stepdoc/schema/storage-api'
export const HostedSessionContext = createContext<{
  session: ApiSession
  health: ApiHealth
  active: boolean
  logout: () => Promise<void>
} | null>(null)
export const useHostedSession = () => useContext(HostedSessionContext)
