import { useEffect, useRef, useState } from 'react'
import { browser } from 'wxt/browser'
import { Button } from '@stepdoc/ui'
import {
  captureTargetErrorSchema,
  captureTargetListSchema,
  captureTargetSchema,
  type CaptureTargetErrorCode,
  type CaptureTargetList,
} from '@stepdoc/schema/capture-target'
import { targetKey, type TargetChoice } from './capture-target-url'
import './capture-target-picker.css'

export const targetMessages: Record<CaptureTargetErrorCode, string> = {
  unavailable: 'Open a web page, then choose it from the page list and retry.',
  changed:
    'That page changed or moved. Refresh the page list and select it again.',
  loading: 'That page is still loading. Wait for it to finish, then retry.',
  expired:
    'That page selection expired. Refresh the list and select a page again.',
  busy: 'Finish or discard the current capture or walkthrough first.',
  forbidden: 'Page selection is available only in the extension controls.',
}
export function CaptureTargetPicker({
  choice,
  onChoice,
  onAvailable,
  onNotice,
  disabled,
}: {
  choice: TargetChoice
  onChoice: (value: TargetChoice) => void
  onAvailable: (value: boolean) => void
  onNotice: (message: string) => void
  disabled: boolean
}) {
  const [data, setData] = useState<CaptureTargetList | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [focusing, setFocusing] = useState(false)
  const sequence = useRef(0),
    notice = useRef(onNotice)
  const alive = useRef(true)
  notice.current = onNotice
  async function refresh() {
    if (!alive.current) return
    const id = ++sequence.current
    setLoading(true)
    try {
      const reply: { ok: boolean; state?: unknown } =
        await browser.runtime.sendMessage({ type: 'CAPTURE_TARGETS' })
      const parsed = captureTargetListSchema.safeParse(reply.state)
      if (!reply.ok || !parsed.success) throw new Error()
      if (id === sequence.current) {
        setData(parsed.data)
        setFailed(false)
      }
    } catch {
      if (id === sequence.current) {
        setFailed(true)
        notice.current(
          'The page list is unavailable. Refresh the list to retry.',
        )
      }
    } finally {
      if (id === sequence.current) setLoading(false)
    }
  }
  useEffect(() => {
    alive.current = true
    void refresh()
    const changed = () => {
      void refresh()
    }
    browser.tabs.onUpdated.addListener(changed)
    browser.tabs.onCreated.addListener(changed)
    browser.tabs.onRemoved.addListener(changed)
    browser.tabs.onActivated.addListener(changed)
    return () => {
      alive.current = false
      sequence.current++
      browser.tabs.onUpdated.removeListener(changed)
      browser.tabs.onCreated.removeListener(changed)
      browser.tabs.onRemoved.removeListener(changed)
      browser.tabs.onActivated.removeListener(changed)
      onAvailable(false)
    }
  }, [])
  useEffect(() => {
    if (!choice.explicit && data?.suggested)
      onChoice({ target: data.suggested, explicit: true, invalid: false })
  }, [choice.explicit, data, onChoice])
  const match = data?.targets.find(
    (target) => targetKey(target) === targetKey(choice.target),
  )
  const ready = !!match?.ready && !loading && !failed && !focusing
  useEffect(() => {
    onAvailable(ready)
  }, [ready, onAvailable])
  const hint = failed
    ? 'The page list is unavailable. Refresh it to retry.'
    : choice.invalid
      ? 'The page link is invalid. Select a web page to continue.'
      : choice.target && data && !match
        ? 'The selected page is unavailable or its selection expired. Select a page again.'
        : match && !match.ready
          ? 'The selected page is still loading.'
          : data?.targets.length === 0
            ? 'Open a web page, then refresh this list.'
            : loading
              ? 'Loading open web pages…'
              : 'Start capture opens the selected page. Only origins and tab numbers are shown.'
  return (
    <section
      className="capture-source"
      aria-labelledby="capture-source-label"
      aria-busy={loading}
    >
      <label className="sd-input" htmlFor="capture-source">
        <span id="capture-source-label" className="sd-input-label">
          Web page to record
        </span>
        <span className="sd-input-field">
          <select
            id="capture-source"
            data-sd="capture-source"
            aria-describedby="capture-source-hint"
            value={targetKey(choice.target)}
            disabled={disabled || focusing}
            onChange={(event) => {
              if (!event.target.value) {
                onChoice({ target: null, explicit: true, invalid: false })
                return
              }
              try {
                const target = captureTargetSchema.parse(
                  JSON.parse(event.target.value),
                )
                onChoice({ target, explicit: true, invalid: false })
              } catch {
                notice.current('Select a web page from the page list.')
              }
            }}
          >
            <option value="">Choose a web page</option>
            {choice.target && !match ? (
              <option value={targetKey(choice.target)} disabled>
                Unavailable — {choice.target.origin} — tab {choice.target.tabId}
              </option>
            ) : null}
            {data?.targets.map((target) => (
              <option
                key={targetKey(target)}
                value={targetKey(target)}
                disabled={!target.ready}
              >
                {target.origin} — tab {target.tabId}
                {target.ready ? '' : ' — loading'}
              </option>
            ))}
          </select>
        </span>
      </label>
      <p id="capture-source-hint">{hint}</p>
      <div className="capture-actions">
        <Button
          kind="ghost"
          size="s"
          data-sd="capture-source-refresh"
          disabled={disabled || focusing}
          onClick={() => void refresh()}
        >
          Refresh pages
        </Button>
        <Button
          kind="secondary"
          size="s"
          data-sd="capture-source-open"
          disabled={disabled || !ready}
          onClick={() => {
            if (!choice.target) return
            setFocusing(true)
            void browser.runtime
              .sendMessage({
                type: 'CAPTURE_FOCUS_TARGET',
                target: choice.target,
              })
              .then(
                (reply: { ok: boolean; code?: unknown }) => {
                  const code = captureTargetErrorSchema.safeParse(reply.code)
                  notice.current(
                    reply.ok
                      ? 'Selected web page opened. Return to these controls or use Alt+Shift+S to start recording.'
                      : targetMessages[
                          code.success ? code.data : 'unavailable'
                        ],
                  )
                },
                () => notice.current(targetMessages.unavailable),
              )
              .finally(() => {
                if (alive.current) {
                  setFocusing(false)
                  void refresh()
                }
              })
          }}
        >
          Show page
        </Button>
      </div>
    </section>
  )
}
