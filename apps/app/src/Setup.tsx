import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import {
  Badge,
  Button,
  Icon,
  Input,
  Logo,
  Toggle,
  setupRadioOff,
  setupRadioOn,
  setupCurrent,
  setupPending,
  type IconName,
} from '@stepdoc/ui'
import type { InstallationStatus } from '@stepdoc/schema/installation'
import {
  apiPairingCodeSchema,
  type ApiSession,
} from '@stepdoc/schema/storage-api'
import type { HostedConfig } from './hosted-config'
import { appHref, isExtensionUrl } from './app-url'
import { HostedAuth, SignInError } from './hosted-auth'
import { SetupClient } from './setup-client'
import { applyPreferences, readPreferences } from './preferences'
import './setup.css'

type Step = 'storage' | 'owner' | 'extension'
type Owner = { name: string; email: string; workspace: string }
const steps: Step[] = ['storage', 'owner', 'extension']
const source =
  'https://github.com/tanzir71/stepdoc/tree/main/apps/extension'
const choices: Array<{
  id: string
  title: string
  icon: IconName
  text: string
  tags: string[]
}> = [
  {
    id: 'browser',
    title: 'This browser',
    icon: 'setup-monitor',
    text: 'IndexedDB + OPFS. No server, no account, works offline. Share by exporting or pushing to a server later.',
    tags: ['Offline', 'Zero setup'],
  },
  {
    id: 'php',
    title: 'Shared hosting',
    icon: 'setup-server',
    text: 'Upload one folder to any PHP 8.1+ host. SQLite file outside the webroot, passkey sign-in, no daemons or cron.',
    tags: ['cPanel', 'PHP 8.1+'],
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare',
    icon: 'setup-cloud',
    text: 'Workers + D1 + R2. This target is not available in this build.',
    tags: ['Cloudflare', 'Coming later'],
  },
  {
    id: 'node',
    title: 'Node + Postgres',
    icon: 'setup-database',
    text: 'A Node server with Postgres or Supabase. This target is not available in this build.',
    tags: ['Docker', 'Coming later'],
  },
]
export function Setup({
  endpoint,
  base,
  hosted,
}: {
  endpoint: string | null
  base: string
  hosted: HostedConfig | null
}) {
  const client = useMemo(
    () => (endpoint ? new SetupClient(endpoint, base) : null),
    [endpoint, base],
  )
  const api = hosted?.api
  const auth = useMemo(
    () => (api ? new HostedAuth({ api, base }) : null),
    [api, base],
  )
  const [status, setStatus] = useState<InstallationStatus>()
  const [session, setSession] = useState<ApiSession | null>(null)
  const [loading, setLoading] = useState(Boolean(client))
  const [step, setStep] = useState<Step>(() =>
    !endpoint &&
    new URL(location.href).searchParams.get('step') === 'extension'
      ? 'extension'
      : 'storage',
  )
  const [selected, setSelected] = useState(
    client || hosted ? 'php' : 'browser',
  )
  const [owner, setOwner] = useState<Owner>({
    name: '',
    email: '',
    workspace: '',
  })
  const [codes, setCodes] = useState<string[]>()
  const [saved, setSaved] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [activity, setActivity] = useState<string[]>([])
  const [pair, setPair] = useState<{ code: string; expiresAt: string }>()
  const main = useRef<HTMLElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const operation = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const announce = useCallback((value: string) => {
    setMessage(value)
    setActivity((items) => [...items.slice(-99), value])
  }, [])
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!client) {
        if (auth) {
          const current = await auth.current(signal)
          if (!signal?.aborted && mounted.current) setSession(current)
        }
        return
      }
      const next = await client.status(signal)
      const current =
        next.phase === 'complete' ? await client.current(signal) : null
      if (signal?.aborted || !mounted.current) return
      setStatus(next)
      setSession(current)
      if (next.owner) setOwner(next.owner)
      setStep(next.phase === 'complete' ? 'extension' : next.phase)
      setLoading(false)
    },
    [client, auth],
  )
  useEffect(() => {
    mounted.current = true
    applyPreferences(readPreferences())
    const controller = new AbortController()
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        setLoading(false)
        announce('Host checks could not finish. Retry the connection.')
      }
    })
    return () => {
      mounted.current = false
      controller.abort()
      operation.current?.abort()
    }
  }, [load, announce])
  useEffect(() => {
    const view = keyOpen
      ? '&view=authorize'
      : codes
        ? '&view=recovery'
        : pair
          ? '&view=pair'
          : ''
    const url = appHref(`/setup?step=${step}&storage=${selected}${view}`)
    history.replaceState(null, '', url)
  }, [step, selected, keyOpen, codes, pair])
  useEffect(() => {
    main.current?.focus({ preventScroll: true })
  }, [step])
  useEffect(() => {
    if (keyOpen) dialog.current?.showModal()
    else {
      dialog.current?.close()
      setKey('')
    }
  }, [keyOpen])
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setMessage('')
    try {
      await action(controller.signal)
    } catch (error) {
      if (mounted.current && !controller.signal.aborted)
        announce(
          error instanceof DOMException &&
            ['AbortError', 'NotAllowedError'].includes(error.name)
            ? 'Passkey setup cancelled. Your details are retained so you can retry.'
            : error instanceof SignInError && error.code === 'unsupported'
              ? 'This browser cannot create a passkey. Use a current browser on HTTPS or localhost.'
              : 'Setup could not finish. Check the installation key and host checks, then retry.',
        )
    } finally {
      if (operation.current === controller) {
        operation.current = null
        if (mounted.current) setBusy(false)
      }
    }
  }
  function cancel() {
    operation.current?.abort()
    operation.current = null
    setBusy(false)
    announce('Operation cancelled. You can retry setup.')
  }
  function continueStorage() {
    if (selected === 'browser') {
      if (hosted) location.assign(base + '/browser/setup?step=extension')
      else setStep('extension')
    } else if (!client) location.assign(appHref('/'))
    else if (status?.phase === 'complete') setStep('extension')
    else if (status?.phase === 'owner') setStep('owner')
    else setKeyOpen(true)
  }
  function unlock(event: FormEvent) {
    event.preventDefault()
    if (!client) return
    const value = key
    setKey('')
    void run(async (signal) => {
      const next = await client.claim(value.trim(), signal)
      if (signal.aborted || !mounted.current) return
      setStatus(next)
      if (next.owner) setOwner(next.owner)
      setKeyOpen(false)
      setStep('owner')
      announce('Host authorized. Create the owner passkey.')
    })
  }
  function register(event: FormEvent) {
    event.preventDefault()
    if (!client) return
    void run(async (signal) => {
      const result = await client.register(owner, signal)
      if (signal.aborted || !mounted.current) return
      if (!result.recoveryCodes) throw new SignInError('unavailable')
      setSession({ ...result, recoveryCodes: undefined })
      setStatus((value) =>
        value ? { ...value, phase: 'complete', owner: undefined } : value,
      )
      setCodes(result.recoveryCodes)
      setSaved(false)
      announce(
        'Owner passkey created. Save the ten recovery codes shown once.',
      )
    })
  }
  const local = !hosted
  const active = steps.indexOf(step)
  return (
    <div className="setup-shell">
      <div className="setup-card">
        <header>
          <nav aria-label="StepDoc">
            <Logo />
          </nav>
          <span className="setup-count">Step {active + 1} of 3</span>
        </header>
        <main
          id="main"
          ref={main}
          tabIndex={-1}
          aria-busy={loading || busy}
        >
          <div className="setup-heading">
            <h1>
              {step === 'storage'
                ? 'Where should your guides live?'
                : step === 'owner'
                  ? codes
                    ? 'Keep your recovery codes safe'
                    : 'Create the owner passkey'
                  : 'Capture your first guide'}
            </h1>
            <p>
              {step === 'storage'
                ? 'Same app in every mode. Export a .stepdoc bundle and move between targets any time — nothing is locked to one host.'
                : step === 'owner'
                  ? codes
                    ? 'These ten codes are shown once. Each code can be used once to regain access.'
                    : 'Name your workspace and create a passkey for its first owner. Your server stores the public key only.'
                  : local
                    ? 'Your browser workspace is ready. Install the extension to capture steps, or start with a manual guide.'
                    : 'Your workspace and owner passkey are ready. Install the extension and pair it with this server.'}
            </p>
          </div>
          {step === 'storage' ? (
            <>
              <fieldset
                className="setup-options"
                role="radiogroup"
                aria-label="Guide storage"
                disabled={busy}
              >
                <legend className="sd-sr-only">
                  Where guides are stored
                </legend>
                {choices.map((choice) => {
                  const enabled =
                    choice.id === 'browser' ||
                    (choice.id === 'php' && Boolean(client || hosted))
                  return (
                    <label
                      className="setup-option"
                      data-selected={selected === choice.id}
                      data-disabled={!enabled}
                      key={choice.id}
                    >
                      <input
                        type="radio"
                        name="setup-storage"
                        aria-label={choice.title}
                        value={choice.id}
                        data-sd={`setup-storage-${choice.id}`}
                        checked={selected === choice.id}
                        disabled={!enabled}
                        onChange={() => setSelected(choice.id)}
                      />
                      <span className="setup-option-heading">
                        <Icon name={choice.icon} />
                        <strong>{choice.title}</strong>
                        <img
                          src={
                            selected === choice.id
                              ? setupRadioOn
                              : setupRadioOff
                          }
                          alt=""
                          width={16}
                          height={16}
                        />
                      </span>
                      <span>{choice.text}</span>
                      <span className="setup-tags">
                        {choice.tags.map((tag) => (
                          <Badge key={tag} dot={false}>
                            {tag}
                          </Badge>
                        ))}
                      </span>
                    </label>
                  )
                })}
              </fieldset>
              <aside
                className="setup-publishing"
                aria-label="Static publishing"
              >
                <Icon name="setup-github" />
                <div>
                  <strong>Read-only static exports</strong>
                  <p>
                    Export HTML, guide.json and agent files. Direct GitHub
                    publishing is planned.
                  </p>
                </div>
                <Toggle
                  data-sd="setup-static-exports"
                  aria-label="Static guide exports are available"
                  on={true}
                  disabled
                />
              </aside>
              {selected === 'php' && client ? (
                <section
                  className="setup-host"
                  aria-labelledby="setup-host-title"
                >
                  <div className="setup-host-heading">
                    <h2 id="setup-host-title">
                      Host check · {location.host}
                    </h2>
                    <Button
                      data-sd="setup-host-retry"
                      kind="ghost"
                      size="s"
                      disabled={busy || loading}
                      onClick={() => {
                        setLoading(true)
                        void run(async (signal) => {
                          try {
                            await load(signal)
                          } finally {
                            if (!signal.aborted) setLoading(false)
                          }
                        })
                      }}
                    >
                      Refresh
                    </Button>
                  </div>
                  <div className="setup-checks">
                    {status?.checks
                      .filter(
                        (check) =>
                          !['openssl', 'passkeys'].includes(check.id) ||
                          check.status !== 'ok',
                      )
                      .map((check) => (
                        <Badge
                          key={check.id}
                          tone={
                            check.status === 'ok'
                              ? 'success'
                              : check.status === 'warn'
                                ? 'warning'
                                : 'danger'
                          }
                        >
                          {check.message}
                        </Badge>
                      ))}
                  </div>
                  {loading ? (
                    <p role="status">Checking this host…</p>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}
          {step === 'owner' ? (
            codes ? (
              <>
                <pre
                  className="hosted-codes"
                  data-sd="setup-recovery-codes"
                >
                  {codes.join('\n')}
                </pre>
                <label className="hosted-check">
                  <input
                    type="checkbox"
                    data-sd="setup-recovery-saved"
                    checked={saved}
                    onChange={(event) => setSaved(event.target.checked)}
                  />
                  I saved my recovery codes somewhere safe
                </label>
              </>
            ) : (
              <form id="setup-owner-form" onSubmit={register}>
                <Input
                  data-sd="setup-workspace"
                  label="Workspace name"
                  value={owner.workspace}
                  maxLength={200}
                  required
                  disabled={busy || Boolean(status?.owner)}
                  onChange={(event) =>
                    setOwner({ ...owner, workspace: event.target.value })
                  }
                />
                <Input
                  data-sd="setup-owner-name"
                  label="Owner name"
                  value={owner.name}
                  maxLength={120}
                  autoComplete="name"
                  required
                  disabled={busy || Boolean(status?.owner)}
                  onChange={(event) =>
                    setOwner({ ...owner, name: event.target.value })
                  }
                />
                <Input
                  data-sd="setup-owner-email"
                  label="Owner email"
                  type="email"
                  value={owner.email}
                  maxLength={254}
                  autoComplete="email"
                  required
                  disabled={busy || Boolean(status?.owner)}
                  onChange={(event) =>
                    setOwner({ ...owner, email: event.target.value })
                  }
                />
              </form>
            )
          ) : null}
          {step === 'extension' ? (
            <>
              <aside
                className="setup-instructions"
                aria-label="Extension installation"
              >
                <p>
                  The Chrome/Edge and Firefox builds share the same guide
                  format.
                </p>
                <a
                  className="setup-link"
                  data-sd="setup-extension-install"
                  href={source}
                  target="_blank"
                  rel="noreferrer"
                >
                  Extension source and installation instructions
                </a>
              </aside>
              {!local ? (
                <section
                  className="setup-pair"
                  aria-labelledby="setup-pair-title"
                >
                  <h2 id="setup-pair-title">Connect the extension</h2>
                  {session ? (
                    <>
                      <p>
                        Open Pair server in the extension. Use this API
                        address and a fresh pairing code.
                      </p>
                      <code data-sd="setup-api-address">{hosted.api}</code>
                      <Button
                        data-sd="setup-pair-create"
                        kind="secondary"
                        disabled={busy}
                        onClick={() => {
                          void run(async (signal) => {
                            const value = client
                              ? await client.pairing(signal)
                              : apiPairingCodeSchema.parse(
                                  await auth?.request(
                                    'pairing/codes',
                                    {},
                                    signal,
                                  ),
                                )
                            if (!signal.aborted) {
                              setPair(value)
                              announce(
                                'Pairing code created. It expires in five minutes and can be used once.',
                              )
                            }
                          })
                        }}
                      >
                        Create pairing code
                      </Button>
                      {pair ? (
                        <div role="status">
                          <code data-sd="setup-pair-code">{pair.code}</code>
                          <p>
                            Use once before{' '}
                            {new Date(pair.expiresAt).toLocaleTimeString()}.
                          </p>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <p>
                      <a data-sd="setup-signin" href={appHref('/signin')}>
                        Sign in
                      </a>{' '}
                      before creating a pairing code.
                    </p>
                  )}
                </section>
              ) : null}
              {isExtensionUrl(new URL(location.href)) ? (
                <p>The extension is already installed in this browser.</p>
              ) : null}
            </>
          ) : null}
          <p
            className="setup-feedback"
            role="status"
            aria-live="polite"
            data-sd="setup-feedback"
          >
            {message}
          </p>
        </main>
        <footer>
          <nav aria-label="Setup steps">
            <ol>
              {['Storage', 'Owner passkey', 'Install extension'].map(
                (label, index) => (
                  <li
                    key={label}
                    aria-current={index === active ? 'step' : undefined}
                  >
                    <img
                      src={index === active ? setupCurrent : setupPending}
                      alt=""
                      width={8}
                      height={8}
                    />
                    {label}
                  </li>
                ),
              )}
            </ol>
          </nav>
          <div className="setup-actions">
            {busy ? (
              <Button data-sd="setup-cancel" kind="ghost" onClick={cancel}>
                Cancel
              </Button>
            ) : null}
            <Button
              data-sd="setup-back"
              kind="ghost"
              disabled={busy || step === 'storage' || Boolean(codes)}
              onClick={() => setStep('storage')}
            >
              Back
            </Button>
            {step === 'storage' ? (
              <Button
                data-sd="setup-continue"
                icon="capture-next"
                disabled={
                  busy ||
                  (selected === 'php' &&
                    Boolean(client) &&
                    (!status?.ready || loading))
                }
                onClick={continueStorage}
              >
                Continue
              </Button>
            ) : step === 'owner' ? (
              codes ? (
                <Button
                  data-sd="setup-continue"
                  icon="capture-next"
                  disabled={!saved || busy}
                  onClick={() => {
                    setCodes(undefined)
                    setStep('extension')
                    announce('Recovery codes acknowledged.')
                  }}
                >
                  Continue
                </Button>
              ) : (
                <Button
                  data-sd="setup-continue"
                  type="submit"
                  form="setup-owner-form"
                  icon="capture-next"
                  disabled={busy}
                >
                  Create owner passkey
                </Button>
              )
            ) : (
              <Button
                data-sd="setup-continue"
                icon="capture-next"
                disabled={busy}
                onClick={() => location.assign(appHref('/'))}
              >
                Open workspace
              </Button>
            )}
          </div>
        </footer>
      </div>
      <aside className="setup-activity" aria-label="Setup activity">
        <details>
          <summary>Activity log</summary>
          <ol>
            {activity.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        </details>
      </aside>
      <dialog
        ref={dialog}
        className="setup-key-dialog"
        aria-labelledby="setup-key-title"
        onCancel={() => {
          cancel()
          setKeyOpen(false)
        }}
        onClose={() => {
          setKeyOpen(false)
          setKey('')
        }}
      >
        <h2 id="setup-key-title">Authorize this installation</h2>
        <p>
          Use the private key saved beside the ZIP as
          stepdoc-php-install-key.txt. It stays in memory for this request.
        </p>
        <form onSubmit={unlock}>
          <Input
            data-sd="setup-key"
            label="Installation key"
            type="password"
            autoComplete="off"
            autoFocus
            value={key}
            required
            maxLength={43}
            minLength={43}
            disabled={busy}
            onChange={(event) => setKey(event.target.value)}
          />
          <div className="setup-actions">
            <Button
              data-sd="setup-key-cancel"
              kind="ghost"
              onClick={() => {
                cancel()
                setKeyOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button data-sd="setup-unlock" type="submit" disabled={busy}>
              Authorize host
            </Button>
          </div>
        </form>
        <p role="status">{keyOpen ? message : ''}</p>
      </dialog>
    </div>
  )
}
