import type { Guide, GuideInput } from '@stepdoc/schema'

export type GuideFilter = Guide['status'] | 'needs-review' | 'replay-passed'
export interface GuideQuery {
  q?: string
  status?: GuideFilter
  collection?: string | null
  cursor?: string
}
/** Field names mirror Storage API v1's GuideSummary. */
export interface GuideSummary {
  id: string
  title: string
  stepCount: number
  status: Guide['status']
  openRedactions: number
  verification: string
  appOrigin?: string
  collectionId: string | null
  thumb: string | null
  updatedAt: string
}
export interface GuidePage {
  items: GuideSummary[]
  nextCursor: string | null
}
export interface GuideVersion {
  version: number
  at: string
  by: string
  summary: string
}
export type BlobKind = 'original' | 'rendered' | 'thumb'
export interface BlobUpload {
  file: Blob
  stepId: string
  kind: BlobKind
}
export interface StorageCapabilities {
  target: 'browser' | 'php-sqlite' | 'cloudflare' | 'node-postgres' | 'static'
  readOnly: boolean
  versions: boolean
  maxUploadBytes: number
}
/** Common guide/blob operations; auth, publishing and collaboration extend this surface later. */
export interface StorageAdapter {
  readonly capabilities: Readonly<StorageCapabilities>
  listGuides(query?: GuideQuery): Promise<GuidePage>
  getGuide(id: string): Promise<Guide>
  createGuide(input: GuideInput): Promise<Guide>
  saveGuide(input: GuideInput, ifMatch: number): Promise<Guide>
  deleteGuide(id: string): Promise<void>
  listVersions(id: string): Promise<GuideVersion[]>
  getVersion(id: string, version: number): Promise<Guide>
  putBlob(id: string, upload: BlobUpload): Promise<{ key: string }>
  getBlob(key: string): Promise<Blob>
  close(): void
}

export type StorageErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_guide'
  | 'invalid_query'
  | 'invalid_blob'
  | 'invalid_options'
  | 'unsupported'
  | 'storage_unavailable'
  | 'storage_full'
  | 'corrupt_data'
  | 'blocked'
  | 'closed'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'upload_too_large'
  | 'redaction_open'
  | 'invalid_pairing'

/** Only safe, fixed messages and numeric conflict metadata cross the adapter boundary. */
export class StorageError extends Error {
  constructor(
    public readonly code: StorageErrorCode,
    public readonly currentVersion?: number,
  ) {
    super(`Storage operation failed: ${code}`)
    this.name = 'StorageError'
  }
}

export function storageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return new StorageError('storage_full')
  return new StorageError('storage_unavailable')
}
