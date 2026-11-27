import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Icon } from '@stepdoc/ui'
import type { CaptureCleanupSuggestion } from '@stepdoc/schema/capture'

interface Snapshot {
  sessionId: string
  revision: number
  suggestions: CaptureCleanupSuggestion[]
}
function cleanupRoute(open: boolean) {
  const url = new URL(location.href)
  if (open) url.searchParams.set('cleanup', 'review')
  else url.searchParams.delete('cleanup')
  history.replaceState(null, '', url)
}
export function CaptureCleanup({
  sessionId,
  revision,
  suggestions,
  disabled,
  onApply,
}: {
  sessionId: string
  revision: number
  suggestions: CaptureCleanupSuggestion[]
  disabled: boolean
  onApply: (
    ids: string[],
    sessionId: string,
    revision: number,
  ) => Promise<boolean>
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const reopen = useRef(
    new URL(location.href).searchParams.get('cleanup') === 'review',
  )
  const [snapshot, setSnapshot] = useState<Snapshot | null>(() =>
    reopen.current ? { sessionId, revision, suggestions } : null,
  )
  const [selected, setSelected] = useState<string[]>(() =>
    reopen.current ? suggestions.map((item) => item.id) : [],
  )
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (reopen.current) dialog.current?.showModal()
    reopen.current = false
  }, [])
  const stale =
    !!snapshot &&
    (snapshot.sessionId !== sessionId || snapshot.revision !== revision)
  return (
    <>
      {suggestions.length ? (
        <aside
          className="capture-cleanup-card"
          aria-labelledby="capture-cleanup-heading"
        >
          <div className="capture-cleanup-heading">
            <Icon name="capture-cleanup" />
            <h2 id="capture-cleanup-heading">
              {suggestions.length} clean-up{' '}
              {suggestions.length === 1 ? 'suggestion' : 'suggestions'}
            </h2>
            <Button
              kind="secondary"
              size="s"
              data-sd="capture-cleanup-open"
              disabled={disabled}
              onClick={() => {
                setSnapshot({ sessionId, revision, suggestions })
                setSelected(suggestions.map((item) => item.id))
                setFailed(false)
                cleanupRoute(true)
                dialog.current?.showModal()
              }}
            >
              Apply
            </Button>
          </div>
          <p>
            {suggestions
              .slice(0, 3)
              .map(
                (item) =>
                  `${item.kind === 'rename' ? 'Rename to ' : item.kind === 'check' ? 'Add a check: ' : ''}${item.title}.`,
              )
              .join(' ')}
            {suggestions.length > 3
              ? ` ${suggestions.length - 3} more to review.`
              : ''}
          </p>
        </aside>
      ) : null}
      <dialog
        ref={dialog}
        aria-labelledby="capture-cleanup-dialog-heading"
        aria-describedby="capture-cleanup-description"
        onClose={() => {
          setSnapshot(null)
          setFailed(false)
          cleanupRoute(false)
        }}
      >
        <h2 id="capture-cleanup-dialog-heading">Review clean-up suggestions</h2>
        <p id="capture-cleanup-description">
          Choose the changes to apply. Suggestions run in this browser and do
          not contact an AI provider.
        </p>
        {stale || failed ? (
          <p role="status" data-sd="capture-cleanup-status">
            {stale
              ? 'This capture changed. Close this dialog and review the current suggestions.'
              : 'Changes could not be applied. Your review is retained. Retry or cancel.'}
          </p>
        ) : null}
        <ul className="capture-cleanup-list">
          {snapshot?.suggestions.map((item) => (
            <li key={item.id}>
              <label>
                <Checkbox
                  data-sd="capture-cleanup-select"
                  aria-label={`${item.title}. ${item.summary}`}
                  disabled={disabled || stale}
                  checked={selected.includes(item.id)}
                  onChange={(event) =>
                    setSelected((ids) =>
                      event.target.checked
                        ? [...ids, item.id]
                        : ids.filter((id) => id !== item.id),
                    )
                  }
                />
                <span>
                  <strong>{item.title}</strong>
                  <span>{item.summary}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="capture-actions">
          <Button
            kind="secondary"
            data-sd="capture-cleanup-cancel"
            disabled={disabled}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </Button>
          <Button
            data-sd="capture-cleanup-apply"
            disabled={disabled || stale || !selected.length}
            onClick={async () => {
              if (!snapshot || stale || disabled) return
              setFailed(false)
              if (
                await onApply(selected, snapshot.sessionId, snapshot.revision)
              )
                dialog.current?.close()
              else setFailed(true)
            }}
          >
            Apply selected
          </Button>
        </div>
      </dialog>
    </>
  )
}
