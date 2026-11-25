import { useEffect, useState } from 'react'
import {
  StorageError,
  type GuideQuery,
  type GuideSummary,
} from '@stepdoc/storage'
import { allGuides, getStorage } from './repository'
export function useLibrary(query: GuideQuery, refresh: number) {
  const [state, setState] = useState<{
    busy: boolean
    items: GuideSummary[]
    all: GuideSummary[]
    reviewCount: number
    error: string | null
  }>({ busy: true, items: [], all: [], reviewCount: 0, error: null })
  const { q, status, collection } = query
  useEffect(() => {
    let active = true
    setState((previous) => ({ ...previous, busy: true, error: null }))
    const requested = { q, status, collection }
    const load = async () => {
      const all = allGuides()
      const review = allGuides({ status: 'needs-review' })
      const filtered =
        !q && status === 'needs-review' && collection === undefined
          ? review
          : q || status || collection !== undefined
            ? allGuides(requested)
            : all
      const [items, full, needsReview] = await Promise.all([
        filtered,
        all,
        review,
      ])
      if (active)
        setState({
          busy: false,
          items,
          all: full,
          reviewCount: needsReview.length,
          error: null,
        })
    }
    void load().catch((error) => {
      if (active)
        setState((previous) => ({
          ...previous,
          busy: false,
          error:
            error instanceof StorageError ? error.code : 'storage_unavailable',
        }))
    })
    return () => {
      active = false
    }
  }, [q, status, collection, refresh])
  return state
}
export function useBlob(key: string | null) {
  const [state, setState] = useState<{
    key: string | null
    url: string | null
  }>({ key: null, url: null })
  useEffect(() => {
    let active = true
    let url: string | null = null
    if (key)
      void getStorage()
        .then((adapter) => adapter.getBlob(key))
        .then((blob) => {
          if (active) {
            url = URL.createObjectURL(blob)
            setState({ key, url })
          }
        })
        .catch(() => {
          if (active) setState({ key, url: null })
        })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [key])
  return state.key === key ? state.url : null
}
