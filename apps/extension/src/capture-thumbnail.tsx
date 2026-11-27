import { useEffect, useRef, useState } from 'react'
import { browser } from 'wxt/browser'
import { CapturePreviews } from './capture-previews'

const previews = new CapturePreviews()
export function CaptureThumbnail({
  sessionId,
  stepId,
}: {
  sessionId?: string
  stepId: string
}) {
  const element = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [preview, setPreview] = useState<{ key: string; url: string }>()
  const key = `${sessionId}/${stepId}`
  useEffect(() => {
    if (!element.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '100px' },
    )
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || !sessionId) return
    let active = true
    let objectUrl: string | undefined
    void (async () => {
      let file = await previews.get(sessionId, stepId)
      if (!file) {
        const reply: { ok: boolean } = await browser.runtime.sendMessage({
          type: 'CAPTURE_PREVIEW',
          sessionId,
          stepId,
        })
        if (!reply.ok) return
        file = await previews.get(sessionId, stepId)
      }
      if (active && file) {
        objectUrl = URL.createObjectURL(file)
        setPreview({ key, url: objectUrl })
      }
    })().catch(() => {})
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [visible, sessionId, stepId, key])
  return (
    <span ref={element} className="capture-thumbnail" aria-hidden="true">
      {preview?.key === key ? (
        <img src={preview.url} alt="" width="56" height="36" />
      ) : null}
    </span>
  )
}
