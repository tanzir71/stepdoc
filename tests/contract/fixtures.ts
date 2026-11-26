import type { IssuedToken } from '@stepdoc/schema/storage-api'
import { phpFixture } from './php-fixture'

export interface ContractFixture {
  target: 'php-sqlite' | 'cloudflare' | 'node-postgres'
  server: { api: string; origin: string }
  peer: { api: string; origin: string }
  owner: IssuedToken
  other: IssuedToken
  reader: IssuedToken
  capture: IssuedToken
  extension: IssuedToken
  extensionOrigin: string
  maxUploadBytes: number
  issue(scopes: string[]): IssuedToken
  revoke(id: string): unknown
  restart(): Promise<void>
  close(): Promise<void>
}
export async function provision(): Promise<ContractFixture> {
  const target = process.env.STEPDOC_CONTRACT_TARGET ?? 'php'
  if (target === 'php') return { ...(await phpFixture()), target: 'php-sqlite' }
  throw new Error(`The ${target} contract fixture is not implemented yet`)
}
