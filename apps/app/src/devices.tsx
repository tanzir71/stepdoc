import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Icon, Input } from '@stepdoc/ui'
import { DevicesHttpClient } from '@stepdoc/storage/http'
import { StorageError } from '@stepdoc/storage'
import {
  apiScopeSchema,
  type ApiDevice,
  type ApiPairingCode,
  type IssuedToken,
  type ApiTokenInput,
} from '@stepdoc/schema/storage-api'
import { useHostedSession } from './hosted-session'
import { hostedConfig } from './hosted-config'
import { sessionFetch } from './repository'
import { useActivity } from './activity'
import { navigate } from './navigation'
import { SettingsNav } from './settings-nav'
import './settings.css'

type Scope = ApiTokenInput['scopes'][number]
const scopeLabels: Record<Scope, string> = {
  'guides:read': 'Read guides',
  'guides:write': 'Create and edit guides',
  'capture:write': 'Save captures',
  'publish:write': 'Publish guides',
  'replay:write': 'Write replay results',
  admin: 'Manage workspace',
}
function failure(error: unknown) {
  if (error instanceof StorageError && error.code === 'invalid_options')
    return 'Use a shorter token name and select at least one allowed action.'
  if (error instanceof StorageError && error.code === 'rate_limited')
    return 'Too many requests. Wait a minute before trying again.'
  if (error instanceof StorageError && error.code === 'forbidden')
    return 'Your current role cannot perform this action. Refresh your session to check access.'
  return 'The request could not be confirmed. Refresh connected devices before retrying; the server may have completed it.'
}
export function DevicesSettings({ search }: { search: string }) {
  const hosted = useHostedSession()
  const [config] = useState(hostedConfig)
  const enabled =
    !!hosted?.active && !!config && hosted.session.member.role !== 'viewer'
  const activity = useActivity()
  const [devices, setDevices] = useState<ApiDevice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [code, setCode] = useState<ApiPairingCode>()
  const [now, setNow] = useState(Date.now)
  const [issued, setIssued] = useState<IssuedToken>()
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Scope[]>([])
  const operation = useRef<AbortController | null>(null)
  const sequence = useRef(0)
  const dialog = useRef<HTMLDialogElement>(null)
  const query = new URLSearchParams(search)
  const action = query.get('action')
  const selected = devices.find((device) => device.id === query.get('device'))
  const modal = action === 'create-token' || (action === 'revoke' && !!selected)
  const route = useRef(search)
  route.current = search
  const inform = (message: string) => {
    setFeedback(message)
    activity(message)
  }
  const close = () => {
    sequence.current++
    operation.current?.abort()
    operation.current = null
    setBusy(false)
    setIssued(undefined)
    setName('')
    setScopes([])
    setFeedback('')
    navigate('/settings/devices')
  }
  const dismiss = () => {
    const pending = !!operation.current
    close()
    if (pending)
      inform(
        'Request cancelled. Refresh connected devices before retrying; the server may have completed it.',
      )
  }
  useEffect(() => {
    if (!enabled || !config) {
      setDevices([])
      setCode(undefined)
      setIssued(undefined)
      setBusy(false)
      setFeedback('')
      setName('')
      setScopes([])
      return
    }
    const controller = new AbortController()
    const client = new DevicesHttpClient(config.api, {
      auth: { kind: 'session' },
      fetch: sessionFetch,
      signal: controller.signal,
    })
    setLoading(true)
    setError('')
    void client
      .list()
      .then((rows) => {
        if (!controller.signal.aborted)
          setDevices(
            rows.sort(
              (a, b) =>
                a.name.localeCompare(b.name) ||
                a.kind.localeCompare(b.kind) ||
                a.scopes.join(',').localeCompare(b.scopes.join(',')) ||
                a.id.localeCompare(b.id),
            ),
          )
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setError(failure(error))
          activity('Connected devices could not be loaded.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
      client.close()
    }
  }, [enabled, config, refresh, activity])
  useEffect(() => {
    if (enabled && modal) dialog.current?.showModal()
    else dialog.current?.close()
    return () => {
      sequence.current++
      operation.current?.abort()
      operation.current = null
      setBusy(false)
      setIssued(undefined)
    }
  }, [enabled, action, query.get('device'), modal])
  useEffect(() => {
    if (!code) return
    const tick = () => {
      const current = Date.now()
      setNow(current)
      if (Date.parse(code.expiresAt) <= current) {
        setCode(undefined)
        inform('Pairing code expired. Create a new code to pair a device.')
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [code])
  async function run<T>(
    work: (client: DevicesHttpClient) => Promise<T>,
    done: (value: T) => void,
  ) {
    if (!enabled || !config || operation.current) return
    const controller = new AbortController()
    const serial = ++sequence.current
    const originalRoute = route.current
    operation.current = controller
    const client = new DevicesHttpClient(config.api, {
      auth: { kind: 'session' },
      fetch: sessionFetch,
      signal: controller.signal,
    })
    setBusy(true)
    setFeedback('')
    try {
      const result = await work(client)
      if (
        !controller.signal.aborted &&
        sequence.current === serial &&
        route.current === originalRoute
      )
        done(result)
    } catch (error) {
      if (!controller.signal.aborted && sequence.current === serial)
        inform(failure(error))
    } finally {
      client.close()
      if (operation.current === controller) {
        operation.current = null
        setBusy(false)
      }
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      inform('Copied to clipboard.')
    } catch {
      inform(
        'Clipboard access was unavailable. Select and copy the displayed value.',
      )
    }
  }
  const seconds = code
    ? Math.max(0, Math.ceil((Date.parse(code.expiresAt) - now) / 1000))
    : 0
  return (
    <div className="settings-layout">
      <SettingsNav current="devices" />
      <div className="devices-workspace">
        <header className="devices-heading">
          <div>
            <h1>Devices &amp; tokens</h1>
            <p>
              Extensions, MCP clients and CI jobs that can reach this workspace.
              Every token is scoped, revocable and stored as a hash.
            </p>
          </div>
          {enabled ? (
            <Button
              kind="secondary"
              icon="devices-key"
              data-sd="token-create"
              onClick={() => {
                setFeedback('')
                navigate('/settings/devices?action=create-token')
              }}
            >
              Create token
            </Button>
          ) : null}
        </header>
        <main id="main" tabIndex={-1} className="devices-main">
          {!enabled ? (
            <section className="devices-card">
              <h2>{hosted ? 'Workspace access required' : 'Server devices'}</h2>
              <p>
                {hosted
                  ? 'Your role can read guides. An owner or editor manages workspace devices and tokens.'
                  : 'This workspace is stored in your browser. Open your server workspace to pair extensions and manage its access tokens.'}
              </p>
            </section>
          ) : (
            <>
              <section
                className="devices-card pairing-card"
                aria-labelledby="pairing-heading"
              >
                <div className="pairing-copy">
                  <h2 id="pairing-heading">Pair a browser extension</h2>
                  <p>
                    In the StepDoc extension open Settings → Pair with server
                    and type this code. One use, expires in 5 minutes. The
                    extension receives a capture:write token, never your
                    passkey.
                  </p>
                  <div className="device-scopes">
                    <Badge dot={false}>capture:write</Badge>
                    <Badge dot={false}>guides:read</Badge>
                    <span>default scopes</span>
                  </div>
                </div>
                <div className="pairing-actions">
                  {code && seconds > 0 ? (
                    <>
                      <output
                        className="pairing-code"
                        aria-label="Pairing code"
                        data-sd="pairing-code"
                      >
                        <span className="sd-sr-only">{code.code}</span>
                        <span aria-hidden="true">
                          {[...code.code].map((letter, index) => (
                            <span
                              key={index}
                              className={
                                letter === '-'
                                  ? 'pairing-dash'
                                  : 'pairing-digit'
                              }
                            >
                              {letter}
                            </span>
                          ))}
                        </span>
                      </output>
                      <div className="pairing-tools">
                        <span>
                          Expires in {Math.floor(seconds / 60)}:
                          {String(seconds % 60).padStart(2, '0')}
                        </span>
                        <Button
                          kind="ghost"
                          size="s"
                          icon="export-copy"
                          data-sd="pairing-copy"
                          onClick={() => void copy(code.code)}
                        >
                          Copy
                        </Button>
                        <Button
                          kind="ghost"
                          size="s"
                          icon="devices-refresh"
                          data-sd="pairing-new"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              (client) => client.pairingCode(),
                              (value) => {
                                setNow(Date.now())
                                setCode(value)
                                inform(
                                  'New pairing code created. Earlier codes retain their original expiry.',
                                )
                              },
                            )
                          }
                        >
                          New code
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button
                      data-sd="pairing-create"
                      kind="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          (client) => client.pairingCode(),
                          (value) => {
                            setNow(Date.now())
                            setCode(value)
                            inform(
                              'Pairing code created. It expires in five minutes.',
                            )
                          },
                        )
                      }
                    >
                      Create pairing code
                    </Button>
                  )}
                </div>
              </section>
              <section
                className="connected-devices"
                aria-labelledby="connected-heading"
                aria-busy={loading}
              >
                <div className="connected-heading">
                  <h2 id="connected-heading">Connected</h2>
                  <Button
                    kind="ghost"
                    size="s"
                    icon="devices-refresh"
                    data-sd="devices-refresh"
                    disabled={loading || busy}
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    Refresh
                  </Button>
                </div>
                {loading ? (
                  <p role="status">Loading connected devices…</p>
                ) : error ? (
                  <p role="alert">{error}</p>
                ) : devices.length ? (
                  <ul aria-label="Connected devices">
                    {devices.map((device) => (
                      <li
                        className="device-row"
                        key={device.id}
                        data-sd="device-row"
                      >
                        <Icon
                          name={
                            device.kind === 'extension'
                              ? 'devices-extension'
                              : device.kind === 'ci'
                                ? 'devices-terminal'
                                : 'devices-bot'
                          }
                        />
                        <div className="device-name">
                          <strong>{device.name}</strong>
                          <span>
                            {device.kind === 'extension'
                              ? 'Paired extension'
                              : 'Scoped API token'}
                          </span>
                        </div>
                        <div className="device-scopes">
                          {device.scopes.map((scope) => (
                            <Badge key={scope} dot={false}>
                              {scope}
                            </Badge>
                          ))}
                        </div>
                        <span className="device-seen">
                          {device.lastSeenAt ? (
                            <time dateTime={device.lastSeenAt}>
                              Seen{' '}
                              {new Date(device.lastSeenAt).toLocaleDateString()}
                            </time>
                          ) : (
                            'Not used yet'
                          )}
                        </span>
                        <Button
                          kind="danger"
                          size="s"
                          data-sd="device-revoke"
                          aria-label={`Revoke ${device.name}`}
                          onClick={() => {
                            setFeedback('')
                            navigate(
                              '/settings/devices?action=revoke&device=' +
                                encodeURIComponent(device.id),
                            )
                          }}
                        >
                          Revoke
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="devices-card">
                    No connected devices yet. Create a pairing code or a scoped
                    token to connect one.
                  </p>
                )}
              </section>
              <aside className="devices-security" aria-label="Token storage">
                <Icon name="devices-lock" />
                <p>
                  Tokens are shown once and stored as SHA-256 hashes. CORS only
                  allows paired extension IDs.
                </p>
              </aside>
            </>
          )}
          <p
            className="devices-feedback"
            role="status"
            data-sd="devices-feedback"
          >
            {feedback}
          </p>
        </main>
      </div>
      {enabled ? (
        <dialog
          ref={dialog}
          className="app-dialog devices-dialog"
          aria-labelledby="devices-dialog-heading"
          onCancel={(event) => {
            event.preventDefault()
            dismiss()
          }}
        >
          <div className="dialog-header">
            <h2 id="devices-dialog-heading">
              {action === 'revoke'
                ? 'Revoke access'
                : issued
                  ? 'Save your token'
                  : 'Create token'}
            </h2>
            <Button
              kind="ghost"
              data-sd="device-dialog-close"
              onClick={dismiss}
            >
              Close
            </Button>
          </div>
          {action === 'revoke' && selected ? (
            <>
              <p>
                Revoke access for <strong>{selected.name}</strong>? Requests
                using this token will be denied immediately.
              </p>
              <Button
                kind="danger"
                data-sd="device-revoke-confirm"
                disabled={busy}
                onClick={() =>
                  void run(
                    (client) => client.revoke(selected.id),
                    () => {
                      close()
                      setRefresh((value) => value + 1)
                      activity('Device access revoked.')
                    },
                  )
                }
              >
                {busy ? 'Revoking…' : 'Revoke access'}
              </Button>
            </>
          ) : issued ? (
            <>
              <p>
                This token is shown once. Store it securely before closing this
                dialog.
              </p>
              <label className="token-value">
                Token
                <textarea
                  data-sd="token-value"
                  readOnly
                  value={issued.token}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <Button
                kind="secondary"
                data-sd="token-copy"
                onClick={() => void copy(issued.token)}
              >
                Copy token
              </Button>
              <Button data-sd="token-done" onClick={close}>
                Done
              </Button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void run(
                  (client) => client.create({ name, scopes }),
                  (value) => {
                    setIssued(value)
                    setRefresh((current) => current + 1)
                    inform('Token created. Copy it before closing this dialog.')
                  },
                )
              }}
            >
              <Input
                data-sd="token-name"
                label="Token name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                required
                autoComplete="off"
              />
              <fieldset>
                <legend>Allowed actions</legend>
                {apiScopeSchema.options
                  .filter(
                    (scope) =>
                      scope !== 'admin' ||
                      hosted?.session.member.role === 'owner',
                  )
                  .map((scope) => (
                    <label key={scope}>
                      <input
                        type="checkbox"
                        data-sd={`token-scope-${scope.replace(':', '-')}`}
                        checked={scopes.includes(scope)}
                        onChange={(event) =>
                          setScopes((current) =>
                            event.target.checked
                              ? [...current, scope]
                              : current.filter((item) => item !== scope),
                          )
                        }
                      />
                      {scopeLabels[scope]} <code>{scope}</code>
                    </label>
                  ))}
              </fieldset>
              <p>
                Choose only the actions this client needs. The token can be
                revoked from this screen.
              </p>
              <Button
                type="submit"
                data-sd="token-submit"
                disabled={busy || !name.trim() || !scopes.length}
              >
                {busy ? 'Creating…' : 'Create token'}
              </Button>
            </form>
          )}
          <p role="status" data-sd="device-dialog-feedback">
            {feedback}
          </p>
        </dialog>
      ) : null}
    </div>
  )
}
