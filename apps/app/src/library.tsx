import type { RefObject } from 'react'
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Input,
  SegmentGroup,
} from '@stepdoc/ui'
import type { GuideSummary } from '@stepdoc/storage'
import { useBlob, type useLibrary } from './hooks'
import {
  editedLabel,
  humanize,
  libraryUrl,
  originLabel,
  type LibraryRoute,
  type LibraryStatus,
} from './model'
import { navigate } from './navigation'
import { ImportControl } from './dialogs'

export type LibraryState = ReturnType<typeof useLibrary>
function GuideCard({ guide }: { guide: GuideSummary }) {
  const url = useBlob(guide.thumb)
  return (
    <li>
      <article className="guide-card">
        <a
          className="guide-card-link"
          href={`/g/${guide.id}`}
          data-sd="library-guide-open"
        >
          <div className="guide-card-thumb">
            {url ? (
              <img src={url} alt={`Screenshot for ${guide.title}`} />
            ) : (
              <span className="guide-thumb-empty" aria-label="No screenshot">
                <Icon name="book" />
              </span>
            )}
            <span className="step-count">
              <Icon name="layers" />
              {guide.stepCount} {guide.stepCount === 1 ? 'step' : 'steps'}
            </span>
          </div>
          <div className="guide-card-copy">
            <h2>{guide.title}</h2>
            <p>
              {originLabel(guide.appOrigin)} ·{' '}
              <time dateTime={guide.updatedAt}>
                {editedLabel(guide.updatedAt)}
              </time>
            </p>
            <div className="guide-badges">
              <Badge
                tone={guide.status === 'published' ? 'success' : 'neutral'}
              >
                {humanize(guide.status)}
              </Badge>
              {guide.openRedactions ? (
                <Badge tone="warning" dot={false}>
                  {guide.openRedactions} to review
                </Badge>
              ) : guide.verification === 'passed' ? (
                <Badge tone="agent" dot={false}>
                  Replay passed
                </Badge>
              ) : guide.verification === 'failed' ? (
                <Badge tone="danger" dot={false}>
                  Replay failed
                </Badge>
              ) : null}
              {guide.collectionId ? (
                <span className="guide-collection">
                  {humanize(guide.collectionId)}
                </span>
              ) : null}
            </div>
          </div>
        </a>
      </article>
    </li>
  )
}
export function StatePanel({
  title,
  children,
  icon = 'book',
  action,
}: {
  title: string
  children: React.ReactNode
  icon?: 'book' | 'server'
  action?: React.ReactNode
}) {
  return (
    <section className="state-panel" aria-labelledby="state-title">
      <Icon name={icon} />
      <h2 id="state-title">{title}</h2>
      <p>{children}</p>
      {action ? <div className="state-actions">{action}</div> : null}
    </section>
  )
}
export function Library({
  state,
  route,
  search,
  searchRef,
  create,
  retry,
}: {
  state: LibraryState
  route: LibraryRoute
  search: string
  searchRef: RefObject<HTMLInputElement | null>
  create: () => void
  retry: () => void
}) {
  const { items, all, busy, error, reviewCount } = state
  const collectionIds = [
    ...new Set(
      all.map((guide) => guide.collectionId).filter((id): id is string => !!id),
    ),
  ].sort()
  const options: { value: LibraryStatus; label: string }[] = [
    { value: 'all', label: `All ${all.length}` },
    {
      value: 'draft',
      label: `Drafts ${all.filter((guide) => guide.status === 'draft').length}`,
    },
    {
      value: 'published',
      label: `Published ${all.filter((guide) => guide.status === 'published').length}`,
    },
    { value: 'needs-review', label: `Needs review ${reviewCount}` },
    {
      value: 'replay-passed',
      label: `Replay passed ${all.filter((guide) => guide.verification === 'passed').length}`,
    },
  ]
  if (route.status === 'archived')
    options.push({
      value: 'archived',
      label: `Archived ${all.filter((guide) => guide.status === 'archived').length}`,
    })
  if (route.sort === 'edited')
    collectionIds.sort(
      (a, b) =>
        all.findIndex((guide) => guide.collectionId === a) -
        all.findIndex((guide) => guide.collectionId === b),
    )
  const sorted =
    route.sort === 'title'
      ? [...items].sort(
          (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
        )
      : items
  const visible = route.showAll ? sorted : sorted.slice(0, 8)
  return (
    <>
      <header className="library-header">
        <div className="library-heading">
          <h1>
            {route.collections
              ? 'Collections'
              : route.query.collection
                ? humanize(route.query.collection)
                : 'Library'}
          </h1>
          <p>
            {all.length} guides · {collectionIds.length} collections · stored in
            this browser
          </p>
        </div>
        <Input
          ref={searchRef}
          className="app-search"
          data-sd="library-search"
          type="search"
          maxLength={1000}
          label="Filter guides"
          icon="search"
          placeholder="Filter by title, app or step text"
          value={route.query.q ?? ''}
          onChange={(event) =>
            navigate(
              libraryUrl(search, { q: event.target.value, collections: null }),
              true,
            )
          }
        />
        <ImportControl />
        <Button
          data-sd="library-create"
          className="new-guide-button"
          icon="record"
          onClick={create}
        >
          New guide
        </Button>
      </header>
      <main id="main" tabIndex={-1} className="library-main">
        <div className="library-filters">
          <SegmentGroup
            value={route.status}
            options={options}
            label="Guide status"
            controls="library-results"
            hook="library-status"
            onChange={(value) =>
              navigate(libraryUrl(search, { status: value, collections: null }))
            }
          />
          <div className="library-sort">
            <Icon name="chevron-down" />
            <select
              aria-label="Sort guides"
              data-sd="library-sort"
              value={route.sort}
              onChange={(event) =>
                navigate(libraryUrl(search, { sort: event.target.value }))
              }
            >
              <option value="edited">Last edited</option>
              <option value="title">Title A–Z</option>
            </select>
          </div>
          <div
            className="library-view"
            role="group"
            aria-label="Library layout"
          >
            <IconButton
              data-sd="library-view-grid"
              aria-label="Grid view"
              aria-pressed={route.view === 'grid'}
              icon="grid"
              kind={route.view === 'grid' ? 'secondary' : 'ghost'}
              onClick={() => navigate(libraryUrl(search, { view: 'grid' }))}
            />
            <IconButton
              data-sd="library-view-list"
              aria-label="List view"
              aria-pressed={route.view === 'list'}
              icon="list"
              kind={route.view === 'list' ? 'secondary' : 'ghost'}
              onClick={() => navigate(libraryUrl(search, { view: 'list' }))}
            />
          </div>
        </div>
        <section
          id="library-results"
          data-sd="library-results"
          role="tabpanel"
          aria-labelledby={`library-status-${route.status}`}
          aria-busy={busy}
        >
          {error ? (
            <StatePanel
              title="Browser storage is unavailable"
              icon="server"
              action={
                <Button data-sd="library-retry" onClick={retry}>
                  Retry
                </Button>
              }
            >
              Guides could not be loaded. No stored guides were changed.
            </StatePanel>
          ) : busy && !all.length ? (
            <div className="library-loading" role="status">
              <span className="sd-sr-only">Loading guides</span>
              {Array.from({ length: 8 }, (_, index) => (
                <div key={index} className="skeleton-card" aria-hidden="true">
                  <div />
                  <span />
                  <span />
                </div>
              ))}
            </div>
          ) : route.collections ? (
            collectionIds.length ? (
              <ul className="collection-grid">
                {collectionIds.map((id) => (
                  <li key={id}>
                    <a
                      href={libraryUrl(search, {
                        collection: id,
                        collections: null,
                        status: null,
                      })}
                      data-sd="library-collection-open"
                    >
                      <Icon name="book" />
                      <h2>{humanize(id)}</h2>
                      <span>
                        {
                          all.filter((guide) => guide.collectionId === id)
                            .length
                        }{' '}
                        guides
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <StatePanel title="No collections yet">
                Imported guides with a collection appear here.
              </StatePanel>
            )
          ) : sorted.length ? (
            <>
              <p className="sd-sr-only" role="status">
                {visible.length} of {sorted.length} guides shown
              </p>
              <ul
                className={`guide-grid ${route.view === 'list' ? 'guide-list' : ''}`}
                aria-label="Guides"
              >
                {visible.map((guide) => (
                  <GuideCard key={guide.id} guide={guide} />
                ))}
              </ul>
              {visible.length < sorted.length ? (
                <div className="show-all">
                  <Button
                    kind="secondary"
                    data-sd="library-show-all"
                    onClick={() =>
                      navigate(libraryUrl(search, { limit: 'all' }))
                    }
                  >
                    Show all {sorted.length} guides
                  </Button>
                </div>
              ) : null}
            </>
          ) : all.length ? (
            <StatePanel
              title="No matching guides"
              action={
                <Button
                  data-sd="library-clear"
                  kind="secondary"
                  onClick={() => navigate('/')}
                >
                  Clear filters
                </Button>
              }
            >
              Try another title, app or step, or choose a different status.
            </StatePanel>
          ) : (
            <StatePanel
              title="Your library is ready"
              action={
                <Button
                  data-sd="library-create-empty"
                  icon="record"
                  onClick={create}
                >
                  Create a guide
                </Button>
              }
            >
              Create a guide or import a guide.json file. Your guides stay on
              this device.
            </StatePanel>
          )}
        </section>
      </main>
    </>
  )
}
