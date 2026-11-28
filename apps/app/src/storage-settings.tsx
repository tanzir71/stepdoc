import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Icon, type IconName } from '@stepdoc/ui'
import type { ApiHealth } from '@stepdoc/schema/storage-api'
import { SettingsNav } from './settings-nav'
import { useHostedSession } from './hosted-session'
import { hostedConfig } from './hosted-config'
import { HostedAuth } from './hosted-auth'
import { getStorage } from './repository'
import { useActivity } from './activity'
import { navigate } from './navigation'
import './settings.css'
import './storage-settings.css'

const targetNames = {
  browser: 'This browser · IndexedDB',
  'php-sqlite': 'Shared hosting · PHP + SQLite',
  cloudflare: 'Cloudflare · Workers + D1 + R2',
  'node-postgres': 'Node + Postgres',
}
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Number((bytes / 1024).toFixed(1))} KB`
    : `${Number((bytes / 1024 / 1024).toFixed(1))} MB`
export function StorageSettings({ search }: { search: string }) {
  const hosted = useHostedSession()
  const active = hosted?.active ?? true
  const [config] = useState(hostedConfig)
  const [health, setHealth] = useState<ApiHealth | undefined>(hosted?.health)
  const [estimate, setEstimate] = useState<StorageEstimate>()
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)
  const [count, setCount] = useState(0)
  const checkJob = useRef<AbortController | null>(null)
  const exportJob = useRef<AbortController | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const announce = useActivity()
  const modal = new URLSearchParams(search).get('action') === 'backup'
  const browserMigration =
    new URLSearchParams(search).get('target') === 'browser'
  const target = config ? health?.target : 'browser'
  const checks = config
    ? (health?.checks ?? [])
    : [
        {
          id: 'local',
          status: 'ok',
          message: 'Guides and redacted images stay in this browser.',
        },
        {
          id: 'offline',
          status: 'ok',
          message: 'Export and import work without a backend.',
        },
        {
          id: 'backup',
          status: 'warn',
          message:
            'Clearing browser data removes this workspace. Keep an exported backup.',
        },
      ]
  const inform = (message: string) => {
    setFeedback(message)
    announce(message)
  }
  const cancel = () => {
    exportJob.current?.abort()
    exportJob.current = null
    if (busy) inform('Workspace export cancelled. No guides were changed.')
    setBusy(false)
    navigate('/settings/storage')
  }
  const refresh = async () => {
    if (!active || checkJob.current) return
    const job = new AbortController()
    checkJob.current = job
    setChecking(true)
    setError('')
    try {
      if (config) {
        const result = await new HostedAuth(config).health(job.signal)
        job.signal.throwIfAborted()
        setHealth(result)
      } else {
        const adapter = await getStorage()
        job.signal.throwIfAborted()
        await adapter.listGuides()
        const result = await navigator.storage?.estimate?.()
        job.signal.throwIfAborted()
        setEstimate(result)
      }
      announce('Storage checks refreshed.')
    } catch {
      if (!job.signal.aborted)
        setError(
          'Checks could not be refreshed. Previously reported results may be out of date. Retry when the workspace is available.',
        )
    } finally {
      if (checkJob.current === job) {
        checkJob.current = null
        setChecking(false)
      }
    }
  }
  useEffect(() => {
    if (!active) {
      checkJob.current?.abort()
      exportJob.current?.abort()
      dialog.current?.close()
      setBusy(false)
    }
    return () => {
      checkJob.current?.abort()
      exportJob.current?.abort()
    }
  }, [active])
  useEffect(() => {
    let mounted = true
    if (!config)
      void navigator.storage
        ?.estimate?.()
        .then((result) => {
          if (mounted) setEstimate(result)
        })
        .catch(() => {})
    return () => {
      mounted = false
    }
  }, [config])
  useEffect(() => {
    if (modal && active) dialog.current?.showModal()
    else {
      dialog.current?.close()
      exportJob.current?.abort()
      exportJob.current = null
      setBusy(false)
    }
  }, [modal, active])
  const backup = async () => {
    if (exportJob.current || !active) return
    const job = new AbortController()
    exportJob.current = job
    setBusy(true)
    setCount(0)
    setFeedback('')
    try {
      const { prepareWorkspace, download } = await import('./exports/client')
      const adapter = await getStorage()
      job.signal.throwIfAborted()
      const file = await prepareWorkspace(adapter, job.signal, (value) => {
        if (!job.signal.aborted) setCount(value)
      })
      job.signal.throwIfAborted()
      download(file)
      inform(
        'Workspace archive downloaded. Restore it with Import in the destination library; guides are restored as copies.',
      )
      navigate('/settings/storage')
    } catch {
      if (!job.signal.aborted)
        inform(
          'Workspace export could not finish. The source may have changed or exceeded the 500-guide / 256 MB archive limit. No guides were changed. Retry after edits have finished, or export guides individually.',
        )
    } finally {
      if (exportJob.current === job) {
        exportJob.current = null
        setBusy(false)
      }
    }
  }
  const availability = (enabled: boolean | undefined) =>
    enabled ? 'Available' : 'Unavailable'
  const capabilities = [
    [
      'Members / roles / passkeys',
      'Single user',
      health?.capabilities.members
        ? `Roles${health.capabilities.passkeys ? ' + passkeys' : ''}`
        : health?.capabilities.passkeys
          ? 'Passkeys'
          : 'Single user',
    ],
    [
      'Public links + embeds',
      'Unavailable',
      availability(health?.capabilities.publicLinks),
    ],
    [
      'GitHub Pages publish',
      'Unavailable',
      availability(health?.capabilities.githubPages),
    ],
    [
      'MCP endpoint (HTTP)',
      'Unavailable',
      availability(health?.capabilities.mcp),
    ],
    [
      'Max screenshot upload',
      '64 MB',
      health ? size(health.capabilities.maxUploadBytes) : 'Not reported',
    ],
  ]
  return (
    <div className="settings-layout">
      <SettingsNav current="storage" />
      <div className="devices-workspace storage-workspace">
        <header className="devices-heading">
          <div>
            <h1>Storage &amp; deploy</h1>
            <p>
              Where this workspace keeps guides and screenshots. The client does
              all image work, so every target stays small.
            </p>
          </div>
          <Button
            kind="secondary"
            icon="export-download"
            data-sd="storage-export"
            disabled={!active}
            onClick={() => navigate('/settings/storage?action=backup')}
          >
            Export everything (.stepdoc)
          </Button>
        </header>
        <main id="main" tabIndex={-1} className="storage-main">
          <section className="storage-health" aria-labelledby="storage-target">
            <div className="storage-health-heading">
              <Icon name={config ? 'storage-server' : 'storage-browser'} />
              <div>
                <h2 id="storage-target">
                  {target ? targetNames[target] : 'Checking storage target'}
                </h2>
                <p>
                  {config
                    ? `${location.host} · Storage API ${health?.version ?? 'not reported'}`
                    : 'Private workspace · single user · offline'}
                </p>
              </div>
              <Badge
                tone={
                  error || checks.some((check) => check.status !== 'ok')
                    ? 'warning'
                    : 'success'
                }
              >
                {error
                  ? 'Check failed'
                  : checks.some((check) => check.status !== 'ok')
                    ? 'Needs attention'
                    : 'Healthy'}
              </Badge>
              <Button
                kind="ghost"
                size="s"
                icon="devices-refresh"
                data-sd="storage-check"
                disabled={checking || !active}
                onClick={() => void refresh()}
              >
                {checking ? 'Checking…' : 'Run checks'}
              </Button>
            </div>
            {error ? <p role="alert">{error}</p> : null}
            <ul className="storage-checks">
              {checks.slice(0, 32).map((check, index) => (
                <li key={`${check.id}-${index}`}>
                  <Icon
                    name={
                      check.status === 'ok'
                        ? 'guide-completed'
                        : 'storage-shield'
                    }
                  />
                  <span>{check.message.slice(0, 500)}</span>
                </li>
              ))}
              <li>
                <Icon name="guide-completed" />
                <span>
                  {config && health
                    ? `Screenshot upload limit: ${size(health.capabilities.maxUploadBytes)}`
                    : 'Client-side image processing and redaction'}
                </span>
              </li>
            </ul>
            <div className="storage-usage">
              <div>
                <span>Storage</span>
                <span>
                  {config
                    ? 'Usage and quota not reported by this server'
                    : estimate?.usage !== undefined && estimate.quota
                      ? `${size(estimate.usage)} of ${size(estimate.quota)} · browser estimate`
                      : 'Usage estimate unavailable'}
                </span>
              </div>
              {!config && estimate?.usage !== undefined && estimate.quota ? (
                <progress
                  aria-label="Estimated browser storage used"
                  value={estimate.usage}
                  max={estimate.quota}
                />
              ) : (
                <div className="storage-usage-track" aria-hidden="true" />
              )}
            </div>
          </section>
          <section aria-labelledby="storage-move">
            <h2 className="storage-eyebrow" id="storage-move">
              Move to another target
            </h2>
            <div className="storage-targets">
              {(
                [
                  [
                    'browser',
                    'This browser',
                    'storage-browser',
                    'Keep a private copy in IndexedDB. Single user, offline.',
                  ],
                  [
                    'cloudflare',
                    'Cloudflare',
                    'storage-cloud',
                    'Workers + D1 + R2. This server target is not available yet.',
                  ],
                  [
                    'node',
                    'Node + Postgres',
                    'storage-database',
                    'This server target is not available yet.',
                  ],
                ] as const
              ).map(([id, label, icon, description]) => (
                <article key={id}>
                  <h3>
                    <Icon name={icon as IconName} />
                    {label}
                  </h3>
                  <p>{description}</p>
                  <Button
                    kind="ghost"
                    size="s"
                    icon="storage-migrate"
                    data-sd={`storage-migrate-${id}`}
                    disabled={id !== 'browser' || !active}
                    onClick={() =>
                      navigate('/settings/storage?action=backup&target=browser')
                    }
                  >
                    {id === 'browser' ? 'Migrate' : 'Pending'}
                  </Button>
                </article>
              ))}
            </div>
          </section>
          <section
            className="storage-capabilities"
            aria-labelledby="storage-capabilities"
          >
            <h2 className="sd-sr-only" id="storage-capabilities">
              Storage capabilities
            </h2>
            <div
              className="storage-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Storage capability comparison"
            >
              <table>
                <thead>
                  <tr>
                    <th scope="col">Capability</th>
                    <th scope="col">Browser</th>
                    <th scope="col">PHP</th>
                    <th scope="col">Cloudflare</th>
                    <th scope="col">Node</th>
                  </tr>
                </thead>
                <tbody>
                {capabilities.map(([label, localCapability, server]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                    <td>{localCapability}</td>
                      {(
                        ['php-sqlite', 'cloudflare', 'node-postgres'] as const
                      ).map((value) => (
                        <td key={value}>
                          {health?.target === value
                            ? server
                            : value === 'php-sqlite'
                              ? 'Connect to check'
                              : 'Pending'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {feedback ? (
            <p role="status" data-sd="storage-feedback">
              {feedback}
            </p>
          ) : null}
          <footer className="storage-footer">
            Archives contain current visible guides and redacted images. Trash,
            version history, sign-in credentials and server configuration are
            excluded. Import a workspace archive from the library to restore
            copies.
          </footer>
        </main>
        <dialog
          ref={dialog}
          className="app-dialog"
          aria-labelledby="storage-backup-heading"
          onCancel={(event) => {
            event.preventDefault()
            cancel()
          }}
        >
          <h2 id="storage-backup-heading">
            {browserMigration
              ? 'Move a copy to this browser'
              : 'Export workspace archive'}
          </h2>
          <p>
            Export up to 500 current guides and their redacted images in one
            .stepdoc archive, up to 256 MB. Trash and version history are
            excluded. Your source workspace stays in place.
          </p>
          {browserMigration ? (
            <p>
              Open your offline StepDoc app or compiled extension, then select
              Import in its library and choose this archive. Restored guides
              become separate copies.
            </p>
          ) : (
            <p>
              Restore with Import in the destination library. Existing guides
              are kept; workspace guides become separate copies.
            </p>
          )}
          {busy ? (
            <p role="status">
              Preparing workspace archive · {count} guides processed…
            </p>
          ) : null}
          {feedback ? <p role="status">{feedback}</p> : null}
          <div className="dialog-actions">
            <Button
              kind="ghost"
              data-sd="storage-export-cancel"
              onClick={cancel}
            >
              {busy ? 'Cancel export' : 'Cancel'}
            </Button>
            <Button
              data-sd="storage-export-confirm"
              disabled={busy || !active}
              onClick={() => void backup()}
            >
              Download workspace archive
            </Button>
          </div>
        </dialog>
      </div>
    </div>
  )
}
