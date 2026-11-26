import { useEffect, useRef, useState } from 'react'
import { browser } from 'wxt/browser'
import { Badge, Button, Icon, Input, Logo } from '@stepdoc/ui'
import {
  pairingStateSchema,
  type PairingState,
  type PairingCommand,
  type PairingErrorCode,
} from '@stepdoc/schema/pairing'
import './pairing-panel.css'

const messages: Record<PairingErrorCode, string> = {
  invalid_code:
    'That code could not be used. Create a new code on the server and try again.',
  invalid_server:
    'Enter a compatible StepDoc server address without a query, fragment or URL credentials.',
  connection_unavailable:
    'The server could not be reached. Check the address and connection, then retry.',
  revoked:
    'This device no longer has server access. Pair again with a new code.',
  storage_unavailable:
    'The private connection store is unavailable. Retry or forget the connection to recover.',
  conflict:
    'The connection changed in another window. Review the current status and retry.',
  busy: 'Finish or discard the current capture or walkthrough before changing the connection.',
  cancelled: 'Stopped pairing. The current connection status is shown below.',
  forbidden: 'This action is available only in the extension controls.',
}
function settingsUrl(server: string) {
  try {
    const url = new URL(server)
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/api/v1/')
    )
      return undefined
    url.pathname = url.pathname.slice(0, -'api/v1/'.length) + 'settings/devices'
    return url.href
  } catch {
    return undefined
  }
}
export function PairingPanel({
  onExit,
  fullTab,
}: {
  onExit: () => void
  fullTab: boolean
}) {
  const [state, setState] = useState<PairingState | null>(null)
  const [server, setServer] = useState('')
  const [chars, setChars] = useState(Array<string>(6).fill(''))
  const [edit, setEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<PairingErrorCode | null>(null)
  const [activity, setActivity] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [forget, setForget] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const cells = useRef<Array<HTMLInputElement | null>>([])
  const operation = useRef(0),
    attempt = useRef<string | undefined>(undefined)
  const update = (next: PairingState) =>
    setState((current) =>
      current?.epoch === next.epoch && current.sequence > next.sequence
        ? current
        : next,
    )
  async function refresh() {
    try {
      const reply: { ok: boolean; state?: unknown } =
        await browser.runtime.sendMessage({ type: 'PAIR_STATUS' })
      const result = pairingStateSchema.safeParse(reply.state)
      if (!reply.ok || !result.success) throw new Error()
      update(result.data)
    } catch {
      setError('storage_unavailable')
    }
  }
  useEffect(() => {
    void refresh()
    const changed: Parameters<
      typeof browser.runtime.onMessage.addListener
    >[0] = (message: unknown, sender) => {
      if (
        sender.id !== browser.runtime.id ||
        sender.tab ||
        !sender.url?.startsWith(browser.runtime.getURL('/'))
      )
        return
      if (
        !message ||
        typeof message !== 'object' ||
        !('type' in message) ||
        message.type !== 'PAIR_STATE' ||
        !('state' in message)
      )
        return
      const result = pairingStateSchema.safeParse(message.state)
      if (result.success) update(result.data)
    }
    browser.runtime.onMessage.addListener(changed)
    return () => browser.runtime.onMessage.removeListener(changed)
  }, [])
  useEffect(() => {
    if (forget) dialog.current?.showModal()
  }, [forget])
  const announce = (text: string) => {
    setNotice(text)
    setActivity((items) => [...items.slice(-99), text])
  }
  async function perform(command: PairingCommand, success: string) {
    const id = ++operation.current
    setBusy(true)
    setError(null)
    try {
      const reply: { ok: boolean; error?: PairingErrorCode } =
        await browser.runtime.sendMessage(command)
      if (id !== operation.current) return false
      if (!reply.ok) {
        setError(reply.error ?? 'connection_unavailable')
        announce(messages[reply.error ?? 'connection_unavailable'])
      } else announce(success)
      await refresh()
      return reply.ok
    } catch {
      if (id === operation.current) {
        setError('connection_unavailable')
        announce(messages.connection_unavailable)
      }
      return false
    } finally {
      if (id === operation.current) setBusy(false)
    }
  }
  const pending = state?.pending
  const blocked = busy || !!pending
  const connection = state?.connection
  const activeError = error ?? state?.error
  const form = edit || !connection
  const leave = () => {
    const id = pending?.id ?? attempt.current
    if (id)
      void browser.runtime
        .sendMessage({ type: 'PAIR_CANCEL', attemptId: id })
        .catch(() => {})
    setChars(Array<string>(6).fill(''))
    onExit()
  }
  return (
    <div className="pair-panel" data-full-tab={fullTab}>
      <header className="capture-header">
        <Logo />
        <a
          href="options.html"
          target="_blank"
          className="capture-settings"
          aria-label="Settings"
          data-sd="capture-settings"
        >
          <Icon name="sliders" />
        </a>
      </header>
      <main className="pair-main">
        {form ? (
          <form
            data-sd="pair-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (blocked || !state?.generation) return
              const code =
                chars.slice(0, 3).join('') + '-' + chars.slice(3).join('')
              const attemptId = crypto.randomUUID()
              attempt.current = attemptId
              setChars(Array<string>(6).fill(''))
              void perform(
                {
                  type: 'PAIR_CONNECT',
                  attemptId,
                  expectedGeneration: state.generation,
                  server: server.trim(),
                  code,
                },
                'Server paired. Captures currently stay in this browser.',
              ).then((paired) => {
                if (paired) setEdit(false)
              })
            }}
          >
            <div className="pair-intro">
              <h1>Connect to a StepDoc server</h1>
              <p>
                Paste your server address and the code from Settings → Devices
                &amp; tokens.
              </p>
            </div>
            <Input
              label="Server address"
              data-sd="pair-server"
              type="url"
              required
              maxLength={4096}
              placeholder="https://ops.northwind.example"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              value={server}
              disabled={blocked}
              onChange={(event) => setServer(event.target.value)}
            />
            <fieldset className="pair-code" disabled={blocked}>
              <legend>Pairing code</legend>
              <div className="pair-code-cells">
                {chars.map((char, index) => (
                  <span className="pair-code-slot" key={index}>
                    {index === 3 ? (
                      <span className="pair-code-hyphen" aria-hidden="true">
                        -
                      </span>
                    ) : null}
                    <input
                      ref={(element) => {
                        cells.current[index] = element
                      }}
                      aria-label={`Pairing code character ${index + 1}`}
                      data-sd={`pair-code-${index + 1}`}
                      value={char}
                      required
                      maxLength={1}
                      pattern="[A-Za-z0-9]"
                      autoCapitalize="characters"
                      autoComplete={index === 0 ? 'one-time-code' : 'off'}
                      spellCheck={false}
                      onFocus={(event) => event.target.select()}
                      onChange={(event) => {
                        const value = event.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, '')
                          .slice(-1)
                        setChars((current) =>
                          current.map((previous, at) =>
                            at === index ? value : previous,
                          ),
                        )
                        if (value)
                          cells.current[Math.min(5, index + 1)]?.focus()
                      }}
                      onPaste={(event) => {
                        const value = event.clipboardData
                          .getData('text')
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, '')
                        if (value.length !== 6) return
                        event.preventDefault()
                        setChars([...value])
                        cells.current[5]?.focus()
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'ArrowLeft' ||
                          (event.key === 'Backspace' && !char)
                        ) {
                          event.preventDefault()
                          cells.current[Math.max(0, index - 1)]?.focus()
                        }
                        if (event.key === 'ArrowRight') {
                          event.preventDefault()
                          cells.current[Math.min(5, index + 1)]?.focus()
                        }
                      }}
                    />
                  </span>
                ))}
              </div>
            </fieldset>
            <Button
              data-sd="pair-submit"
              icon="pair-link"
              disabled={
                blocked ||
                !state?.generation ||
                chars.some((char) => !char) ||
                !server.trim()
              }
              type="submit"
            >
              Pair this browser
            </Button>
            <div className="pair-divider" aria-hidden="true">
              <span />
              or
              <span />
            </div>
            <section
              className="pair-local"
              aria-labelledby="pair-local-heading"
            >
              <h2 id="pair-local-heading">
                <Icon name="pair-monitor" />
                Keep everything in this browser
              </h2>
              <p>
                No server and no account. Export a .stepdoc bundle or pair later
                — local guides move with you.
              </p>
              <Button
                kind="secondary"
                size="s"
                icon="pair-local"
                data-sd="pair-local"
                onClick={leave}
              >
                Use local storage
              </Button>
            </section>
            <aside className="pair-token" aria-label="Connection privacy">
              <Icon name="pair-lock" />
              <p>
                Stores one scoped token (capture:write, guides:read). Revoke it
                any time from the server.
              </p>
            </aside>
          </form>
        ) : (
          <section
            className="pair-connected"
            aria-labelledby="pair-connected-heading"
          >
            <div className="pair-intro">
              <h1 id="pair-connected-heading">
                {connection.status === 'revoked'
                  ? 'Pair this browser again'
                  : 'Server paired'}
              </h1>
              <p>
                Captures currently stay in this browser. Your server connection
                is saved for the paired workspace.
              </p>
            </div>
            <div className="pair-local">
              <h2>
                <Icon name="pair-monitor" />
                Connected server
              </h2>
              <p className="pair-server-name">{connection.server}</p>
              <Badge
                tone={
                  connection.status === 'ready'
                    ? 'success'
                    : connection.status === 'revoked'
                      ? 'danger'
                      : 'neutral'
                }
                dot={false}
              >
                {connection.status === 'ready'
                  ? 'Connection checked'
                  : connection.status === 'revoked'
                    ? 'Access revoked'
                    : connection.status === 'unavailable'
                      ? 'Check connection'
                      : 'Paired'}
              </Badge>
              <p>Scopes: {connection.scopes.join(', ')}</p>
            </div>
            <Button
              data-sd="pair-test"
              disabled={blocked}
              onClick={() => {
                const attemptId = crypto.randomUUID()
                attempt.current = attemptId
                void perform(
                  {
                    type: 'PAIR_TEST',
                    attemptId,
                    expectedGeneration: state!.generation!,
                  },
                  'Connection checked.',
                )
              }}
            >
              Check connection
            </Button>
            <Button
              kind="secondary"
              data-sd="pair-another"
              disabled={blocked}
              onClick={() => {
                setServer(connection.server.replace(/api\/v1\/$/, ''))
                setEdit(true)
                setError(null)
              }}
            >
              Pair again
            </Button>
            <Button
              kind="ghost"
              data-sd="pair-forget"
              disabled={blocked}
              onClick={() => setForget(true)}
            >
              Forget connection on this browser
            </Button>
            {settingsUrl(connection.server) ? (
              <a
                data-sd="pair-devices"
                href={settingsUrl(connection.server)}
                target="_blank"
              >
                Devices &amp; tokens on the server
              </a>
            ) : null}
            <Button
              kind="secondary"
              icon="pair-local"
              data-sd="pair-local"
              onClick={leave}
            >
              Use local storage
            </Button>
          </section>
        )}
        {pending || busy ? (
          <Button
            kind="secondary"
            data-sd="pair-cancel"
            onClick={() => {
              const id = pending?.id ?? attempt.current
              if (id)
                void perform(
                  { type: 'PAIR_CANCEL', attemptId: id },
                  'Stopped the connection request.',
                )
            }}
          >
            Cancel {pending?.kind === 'test' ? 'connection check' : 'pairing'}
          </Button>
        ) : null}
        <p
          role="status"
          data-sd="pair-status"
          className={
            activeError
              ? 'pair-error'
              : notice || blocked
                ? 'pair-message'
                : 'sd-sr-only'
          }
        >
          {activeError
            ? messages[activeError]
            : blocked
              ? 'Connecting…'
              : notice || 'Ready to pair'}
        </p>
        {activeError === 'storage_unavailable' ? (
          <div className="pair-recovery">
            <Button
              kind="secondary"
              data-sd="pair-retry"
              onClick={() => {
                setError(null)
                void refresh()
              }}
            >
              Retry connection store
            </Button>
            <Button
              kind="ghost"
              data-sd="pair-forget"
              onClick={() => setForget(true)}
            >
              Forget unavailable connection
            </Button>
          </div>
        ) : null}
      </main>
      <footer className="pair-footer">
        <nav aria-label="Pairing">
          <Button kind="ghost" size="s" data-sd="pair-back" onClick={leave}>
            Back to capture
          </Button>
        </nav>
      </footer>
      <aside className="capture-activity" aria-label="Pairing activity">
        <details>
          <summary>Activity log</summary>
          <ol>
            {activity.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ol>
        </details>
      </aside>
      {forget ? (
        <dialog
          ref={dialog}
          aria-labelledby="pair-forget-heading"
          onCancel={() => setForget(false)}
          onClose={() => setForget(false)}
        >
          <h2 id="pair-forget-heading">Forget this server connection?</h2>
          <p>
            The credential is removed from this browser. Your local guides stay
            here. Revoke the device on the server to remove its server access.
          </p>
          <div className="capture-actions">
            <Button
              kind="secondary"
              data-sd="pair-forget-cancel"
              onClick={() => setForget(false)}
            >
              Cancel
            </Button>
            <Button
              kind="danger"
              data-sd="pair-forget-confirm"
              onClick={() => {
                setForget(false)
                void perform(
                  {
                    type: 'PAIR_FORGET',
                    expectedGeneration: state?.generation ?? null,
                  },
                  'Connection forgotten on this browser.',
                )
              }}
            >
              Forget connection
            </Button>
          </div>
        </dialog>
      ) : null}
    </div>
  )
}
