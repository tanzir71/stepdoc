import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type MouseEvent,
} from 'react'
import {
  Avatar,
  Badge,
  Button,
  Icon,
  IconButton,
  Kbd,
  Logo,
  NavItem,
  SegmentGroup,
} from '@stepdoc/ui'
import { useLibrary } from './hooks'
import { Library, StatePanel } from './library'
import { Preview } from './preview'
import { RouteBoundary } from './route-boundary'
import { CreateDialog } from './dialogs'
import { humanize, libraryUrl, parseLibrary } from './model'
import { navigate, useLocation } from './navigation'
import { appHref, readAppRoute } from './app-url'
import {
  applyPreferences,
  readPreferences,
  type Preferences,
  type Theme,
} from './preferences'
import { resetStorage } from './repository'
import { useHostedSession } from './hosted-session'

const Editor = lazy(() =>
  import('./editor/Editor').then((module) => ({ default: module.Editor })),
)
const DevicesSettings = lazy(() =>
  import('./devices').then((module) => ({ default: module.DevicesSettings })),
)

export function App() {
  const hosted = useHostedSession()
  const active = hosted?.active ?? true
  const url = useLocation()
  const [pathname, rawSearch = ''] = url.split('?')
  const search = `?${rawSearch}`
  const route = parseLibrary(search)
  const editor = /^\/g\/([a-z0-9][a-z0-9-]{2,80})\/(edit|export)\/?$/.exec(
    pathname ?? '',
  )
  const [preferences, setPreferences] = useState<Preferences>(readPreferences)
  const [refresh, setRefresh] = useState(0)
  const [online, setOnline] = useState(navigator.onLine)
  const searchRef = useRef<HTMLInputElement>(null)
  const createDialog = useRef<HTMLDialogElement>(null)
  const storageDialog = useRef<HTMLDialogElement>(null)
  const state = useLibrary(
    pathname === '/' ? route.query : {},
    refresh,
    !editor && active,
  )
  const collections = [
    ...new Set(
      state.all
        .map((guide) => guide.collectionId)
        .filter((id): id is string => !!id),
    ),
  ].sort(
    (a, b) =>
      state.all.filter((guide) => guide.collectionId === b).length -
        state.all.filter((guide) => guide.collectionId === a).length ||
      a.localeCompare(b),
  )
  useLayoutEffect(() => {
    document.getElementById('main')?.focus({ preventScroll: true })
  }, [pathname])
  const creating =
    pathname === '/' && new URLSearchParams(search).get('create') === '1'
  useEffect(() => {
    if (creating) createDialog.current?.showModal()
    else createDialog.current?.close()
  }, [creating])
  useEffect(() => {
    const changed = () => {
      if (active) setRefresh((value) => value + 1)
    }
    const connection = () => setOnline(navigator.onLine)
    const keyboard = (event: KeyboardEvent) => {
      if (!active) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (document.querySelector('dialog[open]')) return
        if (pathname !== '/') navigate('/')
        requestAnimationFrame(() => searchRef.current?.focus())
      }
    }
    window.addEventListener('stepdoc:data', changed)
    window.addEventListener('focus', changed)
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
    window.addEventListener('keydown', keyboard)
    return () => {
      window.removeEventListener('stepdoc:data', changed)
      window.removeEventListener('focus', changed)
      window.removeEventListener('online', connection)
      window.removeEventListener('offline', connection)
      window.removeEventListener('keydown', keyboard)
    }
  }, [pathname, active])
  useEffect(() => {
    applyPreferences(preferences)
    const media = matchMedia('(prefers-color-scheme: dark)')
    const changed = () => applyPreferences(preferences)
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [preferences])
  useEffect(() => {
    document.title = `StepDoc · ${pathname === '/' ? (route.collections ? 'Collections' : 'Library') : pathname?.startsWith('/settings/') ? 'Settings' : 'Guide'}`
  }, [pathname, route.collections])
  const preview = /^\/g\/([a-z0-9][a-z0-9-]{2,80})\/?$/.exec(pathname ?? '')

  const intercept = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    )
      return
    const anchor = event.target.closest('a')
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      anchor.download ||
      anchor.target ||
      anchor.protocol !== location.protocol ||
      anchor.host !== location.host ||
      (anchor.hash &&
        anchor.pathname === location.pathname &&
        anchor.search === location.search)
    )
      return
    event.preventDefault()
    navigate(readAppRoute(new URL(anchor.href)) + anchor.hash)
  }
  if (editor?.[1])
    return (
      <div onClick={intercept}>
        <RouteBoundary key={editor[1]}>
          <Suspense
            fallback={
              <>
                <header>
                  <nav aria-label="Guide navigation">
                    <a href={appHref('/')} data-sd="route-library">
                      Library
                    </a>
                  </nav>
                </header>
                <main id="main" tabIndex={-1}>
                  <h1>Guide editor</h1>
                  <p role="status">Loading editor…</p>
                </main>
              </>
            }
          >
            <Editor
              key={editor[1]}
              id={editor[1]}
              search={search}
              online={online}
              exportOpen={editor[2] === 'export'}
            />
          </Suspense>
        </RouteBoundary>
      </div>
    )
  return (
    <div
      className={`app-shell ${preferences.collapsed ? 'app-compact' : ''} ${pathname === '/settings/devices' ? 'device-settings-shell' : ''}`}
      onClick={intercept}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="app-sidebar" aria-label="Workspace navigation">
        <div className="side-logo">
          <a
            href={appHref('/')}
            aria-label="StepDoc library"
            data-sd="nav-home"
          >
            <Logo />
          </a>
          <IconButton
            data-sd="nav-collapse"
            icon="columns"
            aria-label={
              preferences.collapsed
                ? 'Expand navigation'
                : 'Collapse navigation'
            }
            aria-expanded={!preferences.collapsed}
            onClick={() =>
              setPreferences((value) => ({
                ...value,
                collapsed: !value.collapsed,
              }))
            }
          />
        </div>
        <button
          className="workspace-switcher"
          data-sd="storage-info"
          aria-label={
            hosted ? 'Server storage details' : 'Browser storage details'
          }
          onClick={() => storageDialog.current?.showModal()}
        >
          <span className="workspace-tile">
            {hosted ? hosted.session.workspace.name.slice(0, 1) : 'B'}
          </span>
          <span className="workspace-copy">
            <strong>{hosted?.session.workspace.name ?? 'This browser'}</strong>
            <span>{hosted ? 'Shared hosting · PHP' : 'Local storage'}</span>
          </span>
          <Icon name="chevron-down" />
        </button>
        <div className="side-spacer" />
        <button
          className="sidebar-search"
          data-sd="library-search-focus"
          onClick={() => {
            if (pathname !== '/') navigate('/')
            requestAnimationFrame(() => searchRef.current?.focus())
          }}
        >
          <Icon name="search" />
          <span>Search guides</span>
          <Kbd>Ctrl K</Kbd>
        </button>
        <div className="side-spacer" />
        <nav aria-label="Workspace" className="primary-nav">
          <NavItem
            data-sd="nav-library"
            href={appHref('/')}
            active={
              pathname === '/' &&
              !route.collections &&
              !route.query.collection &&
              route.status === 'all'
            }
            icon="grid"
            count={state.all.length}
          >
            Library
          </NavItem>
          <NavItem
            data-sd="nav-collections"
            href={appHref('/?collections=1')}
            active={
              pathname === '/' &&
              (route.collections || !!route.query.collection)
            }
            icon="book"
            count={collections.length}
          >
            Collections
          </NavItem>
          <NavItem
            data-sd="nav-drafts"
            href={appHref('/?status=draft')}
            active={pathname === '/' && route.status === 'draft'}
            icon="record"
            count={state.all.filter((guide) => guide.status === 'draft').length}
          >
            Drafts
          </NavItem>
          <NavItem
            data-sd="nav-published"
            href={appHref('/?status=published')}
            active={pathname === '/' && route.status === 'published'}
            icon="link"
          >
            Published
          </NavItem>
          <NavItem
            data-sd="nav-archived"
            href={appHref('/?status=archived')}
            active={pathname === '/' && route.status === 'archived'}
            icon="book"
          >
            Archived
          </NavItem>
        </nav>
        <p className="nav-eyebrow">Collections</p>
        <nav className="collection-nav" aria-label="Collections">
          {collections.length ? (
            collections.slice(0, 3).map((id) => (
              <NavItem
                data-sd="nav-collection"
                key={id}
                href={appHref(libraryUrl('', { collection: id }))}
                active={pathname === '/' && route.query.collection === id}
                icon="book"
                count={
                  state.all.filter((guide) => guide.collectionId === id).length
                }
              >
                {humanize(id)}
              </NavItem>
            ))
          ) : (
            <span className="collection-empty">No collections yet</span>
          )}
        </nav>
        <div className="sidebar-fill" />
        {pathname === '/settings/devices' ? (
          <NavItem
            data-sd="nav-settings"
            href={appHref('/settings/devices')}
            active
            icon="settings-main"
          >
            Settings
          </NavItem>
        ) : null}
        <aside className="agent-card" aria-label="Agent exports">
          <div>
            <Icon name="bot" />
            <strong>Agent exports</strong>
            <Badge tone="agent" dot={false}>
              Ready
            </Badge>
          </div>
          <p>Guide data exports, ready for your local tools.</p>
        </aside>
        <div className="sidebar-footer">
          <Avatar
            initials={
              hosted
                ? hosted.session.member.name.slice(0, 2).toUpperCase()
                : 'YO'
            }
          />
          <div className="owner-copy">
            <strong>{hosted?.session.member.name ?? 'You'}</strong>
            <span>{hosted?.session.member.role ?? 'This device'}</span>
          </div>
          <IconButton
            data-sd="settings-open"
            icon="sliders"
            aria-label={
              hosted ? 'Devices and tokens settings' : 'General settings'
            }
            onClick={() =>
              navigate(hosted ? '/settings/devices' : '/settings/general')
            }
          />
        </div>
        {hosted ? (
          <Button
            data-sd="auth-logout"
            kind="ghost"
            onClick={() => {
              void hosted.logout()
            }}
          >
            Sign out
          </Button>
        ) : null}
      </aside>
      <div className="app-workspace">
        {!online ? (
          <p role="status" className="offline-banner">
            <Icon name="offline" />
            {hosted
              ? 'Offline · reconnect to save changes to the server.'
              : 'Offline · browser storage remains available.'}
          </p>
        ) : null}
        {pathname === '/' ? (
          <Library
            state={state}
            route={route}
            search={search}
            searchRef={searchRef}
            create={() => navigate(libraryUrl(search, { create: '1' }))}
            retry={() => {
              resetStorage()
              setRefresh((value) => value + 1)
            }}
          />
        ) : preview?.[1] ? (
          <Preview id={preview[1]} refresh={refresh} />
        ) : pathname === '/settings/devices' ? (
          <RouteBoundary>
            <Suspense
              fallback={
                <main id="main" tabIndex={-1}>
                  <h1>Devices &amp; tokens</h1>
                  <p role="status">Loading settings…</p>
                </main>
              }
            >
              <DevicesSettings search={search} />
            </Suspense>
          </RouteBoundary>
        ) : pathname === '/settings/general' ? (
          <>
            <header className="settings-header">
              <h1>Settings</h1>
              <p>General · preferences for this browser</p>
            </header>
            <main id="main" tabIndex={-1} className="settings-main">
              <section aria-labelledby="appearance-heading">
                <h2 id="appearance-heading">Appearance</h2>
                {hosted ? (
                  <Button
                    data-sd="settings-devices"
                    kind="ghost"
                    onClick={() => navigate('/settings/devices')}
                  >
                    Devices &amp; tokens
                  </Button>
                ) : null}
                <p>Choose a theme for StepDoc.</p>
                <SegmentGroup<Theme>
                  value={preferences.theme}
                  options={[
                    { value: 'light', label: 'Light' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'system', label: 'System' },
                  ]}
                  label="Theme"
                  controls="appearance-panel"
                  hook="theme"
                  onChange={(theme) =>
                    setPreferences((value) => ({ ...value, theme }))
                  }
                />
                <div
                  id="appearance-panel"
                  role="tabpanel"
                  aria-labelledby={`theme-${preferences.theme}`}
                >
                  <p>
                    {preferences.theme === 'system'
                      ? 'Follows your device appearance.'
                      : `${humanize(preferences.theme)} theme selected.`}
                  </p>
                </div>
              </section>
              <section aria-labelledby="storage-heading">
                <h2 id="storage-heading">Storage</h2>
                <p>
                  Guides and images are stored on this device. Export important
                  guides before clearing browser data.
                </p>
                <Button
                  data-sd="settings-storage-details"
                  kind="secondary"
                  onClick={() => storageDialog.current?.showModal()}
                >
                  Storage details
                </Button>
              </section>
            </main>
          </>
        ) : (
          <>
            <header className="settings-header">
              <h1>Page not found</h1>
            </header>
            <main id="main" tabIndex={-1}>
              <StatePanel
                title="This page is unavailable"
                action={
                  <Button
                    data-sd="not-found-home"
                    onClick={() => navigate('/')}
                  >
                    Open library
                  </Button>
                }
              >
                Use the library to find a saved guide.
              </StatePanel>
            </main>
          </>
        )}
      </div>
      <CreateDialog dialog={createDialog} />
      <dialog
        ref={storageDialog}
        className="app-dialog"
        aria-labelledby="storage-dialog-heading"
      >
        <h2 id="storage-dialog-heading">
          {hosted ? 'Stored on your server' : 'Stored in this browser'}
        </h2>
        <p>
          {hosted
            ? `${hosted.session.workspace.name} contains ${state.all.length} guides on this server.`
            : `Your library contains ${state.all.length} guides on this device. There is no cloud account connected.`}
        </p>
        <p>
          {hosted
            ? 'Sign in on another device to use this workspace. Export a .stepdoc bundle to move a guide to another target.'
            : 'Export guides you want to keep before clearing browser data or moving to another device.'}
        </p>
        <div className="dialog-actions">
          <Button
            data-sd="storage-info-close"
            onClick={() => storageDialog.current?.close()}
          >
            Close
          </Button>
        </div>
      </dialog>
    </div>
  )
}
