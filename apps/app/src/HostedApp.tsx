import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Button, Input, Logo } from '@stepdoc/ui'
import type { ApiHealth, ApiSession } from '@stepdoc/schema/storage-api'
import { App } from './App'
import { hostedConfig, clientBase, setupEndpoint } from './hosted-config'
import { readAppRoute } from './app-url'
import { HostedAuth, SignInError, signInMessages } from './hosted-auth'
import { HostedSessionContext } from './hosted-session'
import { resetStorage, renewStorageSession, changed } from './repository'
import './hosted.css'
const Setup = lazy(() =>
  import('./Setup').then((module) => ({ default: module.Setup })),
)

export function HostedApp() {
  const [config] = useState(() => {
    try {
      return {
        hosted: hostedConfig(),
        base: clientBase(),
        endpoint: setupEndpoint(),
      }
    } catch {
      return 'invalid' as const
    }
  })
  return config === 'invalid' ? (
    <AuthShell title="App configuration is unavailable">
      <p role="alert">
        This installation could not be opened. Check its server
        configuration and reload.
      </p>
    </AuthShell>
  ) : config.endpoint || readAppRoute().split('?')[0] === '/setup' ? (
    <Suspense
      fallback={
        <AuthShell title="Opening setup">
          <p role="status">Loading setup…</p>
        </AuthShell>
      }
    >
      <Setup
        endpoint={config.endpoint}
        base={config.base}
        hosted={config.hosted}
      />
    </Suspense>
  ) : config.hosted ? (
    <HostedRuntime api={config.hosted.api} base={config.hosted.base} />
  ) : (
    <App />
  )
}
function AuthShell({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const main = useRef<HTMLElement>(null)
  useEffect(() => {
    main.current?.focus({ preventScroll: true })
  }, [title])
  return (
    <div className="hosted-shell">
      <div className="hosted-card">
        <header>
          <nav aria-label="StepDoc">
            <Logo />
          </nav>
          <span className="hosted-eyebrow">Your workspace</span>
        </header>
        <main id="main" ref={main} tabIndex={-1}>
          <h1>{title}</h1>
          {children}
        </main>
        <footer>Guides on your own server.</footer>
      </div>
    </div>
  )
}
function HostedRuntime({ api, base }: { api: string; base: string }) {
  const client = useMemo(() => new HostedAuth({ api, base }), [api, base])
  const [health, setHealth] = useState<ApiHealth>()
  const [session, setSession] = useState<ApiSession>()
  const [status, setStatus] = useState<
    'loading' | 'signin' | 'ready' | 'error' | 'enroll'
  >('loading')
  const [codes, setCodes] = useState<string[]>()
  const generation = useRef(0)
  const opened = useRef<string | undefined>(undefined)
  const current = useRef({ session, status })
  current.current = { session, status }
  const accept = useCallback((value: ApiSession, prompt = true) => {
    generation.current++
    renewStorageSession()
    const previous = current.current.session
    if (
      previous?.member.id !== value.member.id ||
      previous?.workspace.id !== value.workspace.id
    )
      resetStorage()
    setSession({ ...value, recoveryCodes: undefined })
    setCodes(value.recoveryCodes)
    setStatus(
      (prompt && value.needsPasskey) || value.recoveryCodes
        ? 'enroll'
        : 'ready',
    )
    changed()
  }, [])
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const number = ++generation.current
      try {
        const [nextHealth, nextSession] = await Promise.all([
          client.health(signal),
          client.current(signal),
        ])
        if (signal?.aborted || number !== generation.current) return
        setHealth(nextHealth)
        if (nextSession) accept(nextSession, false)
        else {
          setStatus('signin')
        }
      } catch {
        if (!signal?.aborted && number === generation.current)
          setStatus('error')
      }
    },
    [client, accept],
  )
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const unauthorized = () => {
      generation.current++
      setStatus('signin')
    }
    const focus = () => {
      if (
        document.visibilityState !== 'visible' ||
        current.current.status !== 'ready'
      )
        return
      const number = generation.current
      void client
        .current(controller.signal)
        .then((next) => {
          if (controller.signal.aborted || number !== generation.current)
            return
          if (!next) unauthorized()
          else if (
            next.member.id !== current.current.session?.member.id ||
            next.workspace.id !== current.current.session?.workspace.id
          )
            accept(next, false)
          else setSession(next)
        })
        .catch(() => {})
    }
    window.addEventListener('stepdoc:unauthorized', unauthorized)
    window.addEventListener('focus', focus)
    return () => {
      controller.abort()
      window.removeEventListener('stepdoc:unauthorized', unauthorized)
      window.removeEventListener('focus', focus)
    }
  }, [refresh, client, accept])
  async function logout() {
    try {
      await client.logout()
      generation.current++
      renewStorageSession()
      resetStorage()
      opened.current = undefined
      setSession(undefined)
      setCodes(undefined)
      setStatus('signin')
    } catch {
      setStatus('error')
    }
  }
  const identity = session
    ? `${session.workspace.id}/${session.member.id}`
    : undefined
  if (status === 'ready') opened.current = identity
  return (
    <>
      {session && health && identity === opened.current ? (
        <div hidden={status !== 'ready'}>
          <HostedSessionContext.Provider
            value={{ session, health, logout, active: status === 'ready' }}
          >
            <App key={`${session.workspace.id}/${session.member.id}`} />
          </HostedSessionContext.Provider>
        </div>
      ) : null}
      {status === 'loading' ? (
        <AuthShell title="Opening your workspace">
          <p role="status">Checking your session…</p>
        </AuthShell>
      ) : null}
      {status === 'error' ? (
        <AuthShell title="Workspace unavailable">
          <p role="alert">{signInMessages.unavailable}</p>
          <Button
            data-sd="auth-retry"
            onClick={() => {
              setStatus('loading')
              void refresh()
            }}
          >
            Retry connection
          </Button>
        </AuthShell>
      ) : null}
      {status === 'signin' ? (
        <SignIn
          client={client}
          emailEnabled={!!health?.capabilities.emailCodes}
          accept={accept}
        />
      ) : null}
      {status === 'enroll' && session ? (
        <Enrollment
          client={client}
          email={session.member.email}
          codes={codes}
          accept={accept}
          complete={() => {
            setCodes(undefined)
            setStatus('ready')
          }}
        />
      ) : null}
    </>
  )
}
function useAuthOperation() {
  const active = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const cancel = () => {
    active.current?.abort()
    active.current = null
    setBusy(false)
  }
  useEffect(() => () => active.current?.abort(), [])
  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setMessage('')
    try {
      await operation(controller.signal)
    } catch (error) {
      if (active.current === controller)
        setMessage(
          signInMessages[
            error instanceof SignInError ? error.code : 'unavailable'
          ],
        )
    } finally {
      if (active.current === controller) {
        active.current = null
        setBusy(false)
      }
    }
  }
  return { busy, message, setMessage, cancel, run }
}
function SignIn({
  client,
  emailEnabled,
  accept,
}: {
  client: HostedAuth
  emailEnabled: boolean
  accept: (session: ApiSession) => void
}) {
  const operation = useAuthOperation()
  const [method, setMethod] = useState<'passkey' | 'email' | 'recovery'>(
    'passkey',
  )
  const [sent, setSent] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    await operation.run(async (signal) => {
      if (method === 'passkey') accept(await client.passkey(false, signal))
      else if (method === 'email' && !sent) {
        await client.email(email.trim(), signal)
        setSent(true)
        operation.setMessage(
          'If this address has access, a sign-in code has been sent. It expires in 10 minutes.',
        )
      } else {
        const result = await client.code(
          email.trim(),
          code.trim(),
          method === 'recovery',
          signal,
        )
        setCode('')
        accept(result)
      }
    })
  }
  function choose(next: typeof method) {
    operation.cancel()
    operation.setMessage('')
    setMethod(next)
    setCode('')
    setSent(false)
  }
  return (
    <AuthShell title="Sign in to your workspace">
      <p className="hosted-description">
        Use a passkey, or a one-time code if your passkey is unavailable.
      </p>
      <nav aria-label="Sign-in method" className="hosted-methods">
        <Button
          data-sd="auth-method-passkey"
          kind={method === 'passkey' ? 'secondary' : 'ghost'}
          aria-pressed={method === 'passkey'}
          onClick={() => choose('passkey')}
        >
          Passkey
        </Button>
        {emailEnabled ? (
          <Button
            data-sd="auth-method-email"
            kind={method === 'email' ? 'secondary' : 'ghost'}
            aria-pressed={method === 'email'}
            onClick={() => choose('email')}
          >
            Email code
          </Button>
        ) : null}
        <Button
          data-sd="auth-method-recovery"
          kind={method === 'recovery' ? 'secondary' : 'ghost'}
          aria-pressed={method === 'recovery'}
          onClick={() => choose('recovery')}
        >
          Recovery code
        </Button>
      </nav>
      <form
        onSubmit={(event) => {
          void submit(event)
        }}
        aria-busy={operation.busy}
      >
        {method === 'passkey' ? (
          <p>
            Use the passkey saved on this device or another device you
            trust.
          </p>
        ) : (
          <>
            <Input
              label="Email address"
              data-sd="auth-email"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
              value={email}
              disabled={operation.busy || sent}
              onChange={(event) => setEmail(event.target.value)}
            />
            {sent || method === 'recovery' ? (
              <Input
                label={
                  method === 'recovery' ? 'Recovery code' : '6-digit code'
                }
                data-sd="auth-code"
                type="password"
                autoComplete="one-time-code"
                required
                maxLength={method === 'recovery' ? 27 : 6}
                pattern={
                  method === 'recovery'
                    ? '[A-Fa-f0-9]{6}(-[A-Fa-f0-9]{6}){3}'
                    : '[0-9]{6}'
                }
                inputMode={method === 'recovery' ? 'text' : 'numeric'}
                value={code}
                disabled={operation.busy}
                onChange={(event) => setCode(event.target.value)}
              />
            ) : null}
          </>
        )}
        <div className="hosted-actions">
          <Button
            data-sd="auth-submit"
            type="submit"
            disabled={operation.busy}
          >
            {operation.busy
              ? 'Signing in…'
              : method === 'email' && !sent
                ? 'Send sign-in code'
                : method === 'passkey'
                  ? 'Sign in with a passkey'
                  : 'Sign in'}
          </Button>
          {operation.busy ? (
            <Button
              data-sd="auth-cancel"
              kind="ghost"
              onClick={() => {
                operation.cancel()
                operation.setMessage('Sign-in cancelled.')
                setCode('')
              }}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
      <p role="status" aria-live="polite">
        {operation.message}
      </p>
      <aside aria-label="Sign-in help">
        Your saved guides stay on this server. A sign-in code can be used
        once.
      </aside>
    </AuthShell>
  )
}
function Enrollment({
  client,
  email,
  codes,
  accept,
  complete,
}: {
  client: HostedAuth
  email: string
  codes?: string[]
  accept: (session: ApiSession) => void
  complete: () => void
}) {
  const operation = useAuthOperation()
  const [saved, setSaved] = useState(false)
  return (
    <AuthShell
      title={
        codes
          ? 'Keep your recovery codes safe'
          : 'Add a passkey to this device'
      }
    >
      {codes ? (
        <>
          <p>
            These ten codes are shown once. Each code can be used once to
            regain access.
          </p>
          <pre className="hosted-codes" data-sd="auth-recovery-codes">
            {codes.join('\n')}
          </pre>
          <label className="hosted-check">
            <input
              type="checkbox"
              data-sd="auth-recovery-saved"
              checked={saved}
              onChange={(event) => setSaved(event.target.checked)}
            />
            I saved my recovery codes somewhere safe
          </label>
          <Button
            data-sd="auth-continue"
            disabled={!saved}
            onClick={complete}
          >
            Open workspace
          </Button>
        </>
      ) : (
        <>
          <p>
            You signed in with a code. Add a passkey for your next sign-in.
          </p>
          <div className="hosted-actions">
            <Button
              data-sd="auth-enroll"
              disabled={operation.busy}
              onClick={() => {
                void operation.run(async (signal) =>
                  accept(await client.passkey(true, signal, email)),
                )
              }}
            >
              Add passkey
            </Button>
            <Button
              data-sd="auth-continue"
              kind="ghost"
              disabled={operation.busy}
              onClick={complete}
            >
              Continue for now
            </Button>
          </div>
        </>
      )}
      {operation.busy ? (
        <Button
          data-sd="auth-cancel"
          kind="ghost"
          onClick={operation.cancel}
        >
          Cancel
        </Button>
      ) : null}
      <p role="status" aria-live="polite">
        {operation.message}
      </p>
    </AuthShell>
  )
}
