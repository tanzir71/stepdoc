import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Button } from '@stepdoc/ui'
interface Entry {
  id: number
  message: string
  at: string
}
const ActivityContext = createContext<((message: string) => void) | null>(null)
export function useActivity() {
  const context = useContext(ActivityContext)
  if (!context) throw new Error('ActivityProvider is required')
  return context
}
export function ActivityProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const sequence = useRef(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const announce = useCallback((message: string) => {
    setEntries((previous) => [
      ...previous.slice(-99),
      { id: ++sequence.current, message, at: new Date().toISOString() },
    ])
    setToast(message)
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(timer)
  }, [toast])
  return (
    <ActivityContext.Provider value={announce}>
      {children}
      <div
        className="app-live sd-sr-only"
        data-sd="activity-live"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {toast}
      </div>
      <footer className="activity-footer">
        <Button
          data-sd="activity-open"
          kind="ghost"
          size="s"
          onClick={() => dialog.current?.showModal()}
        >
          Activity{entries.length ? ` (${entries.length})` : ''}
        </Button>
      </footer>
      {toast ? (
        <div className="toast">
          <span>{toast}</span>
          <Button
            data-sd="activity-dismiss"
            kind="ghost"
            size="s"
            onClick={() => setToast(null)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      <dialog
        ref={dialog}
        className="app-dialog"
        aria-labelledby="activity-heading"
      >
        <div className="dialog-header">
          <h2 id="activity-heading">Activity log</h2>
          <Button
            data-sd="activity-close"
            kind="ghost"
            onClick={() => dialog.current?.close()}
          >
            Close
          </Button>
        </div>
        <ol aria-label="Recent activity" className="activity-list">
          {entries.length ? (
            entries.map((entry) => (
              <li key={entry.id}>
                <time dateTime={entry.at}>
                  {new Date(entry.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
                <span>{entry.message}</span>
              </li>
            ))
          ) : (
            <li>No activity yet.</li>
          )}
        </ol>
      </dialog>
    </ActivityContext.Provider>
  )
}
