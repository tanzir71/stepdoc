import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Badge, Button, Checkbox, Icon, IconButton, Toggle } from '@stepdoc/ui'
import type { Guide } from '@stepdoc/schema'
import { exportMarkdown } from '@stepdoc/core/export/markdown'
import { useActivity } from '../activity'
import { getStorage } from '../repository'
import { navigate } from '../navigation'
import { formats, selectedFormats, exportUrl, type ExportFormat } from './model'
import { download, prepareDownload, printDocument } from './client'
import './styles.css'

export function ExportDialog({
  guide,
  search,
  close,
}: {
  guide: Guide
  search: string
  close: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const job = useRef<AbortController | null>(null)
  const copyMenu = useRef<HTMLDetailsElement>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const announce = useActivity()
  const selected = selectedFormats(search)
  const downloads = selected.filter((format) => format !== 'pdf')
  const open = guide.steps.reduce(
    (sum, step) =>
      sum + step.redactions.filter((item) => item.status === 'open').length,
    0,
  )
  const select = (format: ExportFormat, on: boolean) => {
    const next = new Set(selected)
    if (on) next.add(format)
    else next.delete(format)
    navigate(exportUrl(guide.id, search, [...next]), true)
  }
  const message = (value: string, error = false) => {
    setFeedback(value)
    setFailed(error)
    announce(value)
  }
  useLayoutEffect(() => {
    dialog.current?.showModal()
  }, [])
  useEffect(
    () => () => {
      job.current?.abort()
      dialog.current?.close()
    },
    [],
  )
  const dismiss = () => {
    job.current?.abort()
    if (job.current) announce('Export cancelled. Your guide was kept.')
    dialog.current?.close()
  }
  const markdownText = () =>
    exportMarkdown({
      ...guide,
      steps: guide.steps.map((step) => ({ ...step, screenshot: undefined })),
    })
  const copyMarkdown = () => {
    if (copyMenu.current) copyMenu.current.open = false
    void navigator.clipboard
      .writeText(markdownText())
      .then(() =>
        message('Markdown text copied. Images are available in the download.'),
      )
      .catch(() =>
        message('Clipboard unavailable. Download Markdown instead.', true),
      )
  }
  const run = (operation: 'download' | 'print' | 'copy' | 'rich') => {
    if (job.current) return
    const controller = new AbortController()
    if (copyMenu.current) copyMenu.current.open = false
    job.current = controller
    setBusy(true)
    setFailed(false)
    setFeedback(
      operation === 'print'
        ? 'Preparing the printable guide on this device…'
        : 'Preparing export files on this device…',
    )
    void (async () => {
      const adapter = await getStorage()
      const chosen: ExportFormat[] =
        operation === 'print'
          ? ['pdf']
          : operation === 'copy' || operation === 'rich'
            ? ['html']
            : downloads
      const result = await prepareDownload(
        adapter,
        guide,
        chosen,
        controller.signal,
      )
      if (controller.signal.aborted) return
      if (operation === 'copy' || operation === 'rich') {
        if (!result.clipboardHtml) throw new Error('export_failed')
        if (
          operation === 'rich' &&
          typeof ClipboardItem !== 'undefined' &&
          navigator.clipboard.write
        ) {
          await navigator.clipboard.write([
            new ClipboardItem({
              'text/html': new Blob([result.clipboardHtml], {
                type: 'text/html',
              }),
              'text/plain': new Blob([markdownText()], { type: 'text/plain' }),
            }),
          ])
          if (!controller.signal.aborted)
            message('Rich text and images copied. This guide is still private.')
        } else {
          await navigator.clipboard.writeText(
            operation === 'rich' ? markdownText() : result.clipboardHtml,
          )
          if (!controller.signal.aborted)
            message(
              operation === 'rich'
                ? 'Rich text unavailable; Markdown text copied.'
                : 'Self-contained HTML copied. This guide is still private.',
            )
        }
      } else if (operation === 'print') {
        if (!result.printHtml) throw new Error('export_failed')
        await printDocument(result.printHtml, controller.signal)
        if (!controller.signal.aborted)
          message('Print dialog opened. Choose Save as PDF to save a PDF file.')
      } else {
        if (!result.file) throw new Error('export_failed')
        download(result.file)
        message(
          chosen.length === 1 && chosen[0] === 'json'
            ? 'Guide JSON downloaded. Image files are separate; choose .stepdoc for a complete portable copy.'
            : 'Export downloaded. Multiple files and their images are packaged in one ZIP.',
        )
      }
    })()
      .catch(() => {
        if (!controller.signal.aborted)
          message(
            'The export could not finish. Check that its images are available, then retry. Your guide was kept.',
            true,
          )
      })
      .finally(() => {
        if (job.current === controller) {
          job.current = null
          setBusy(false)
        }
      })
  }
  const hostSet: ExportFormat[] = ['html', 'json', 'markdown']
  return (
    <dialog
      ref={dialog}
      className="export-dialog"
      aria-labelledby="export-heading"
      aria-describedby="export-subtitle"
      onCancel={(event) => {
        event.preventDefault()
        dismiss()
      }}
      onClose={() => {
        if (/\/export\/?$/.test(location.pathname)) close()
      }}
    >
      <header className="export-header">
        <div>
          <h2 id="export-heading">Export &amp; publish</h2>
          <p id="export-subtitle">
            {guide.title} · {guide.steps.length} steps · v{guide.version}
          </p>
        </div>
        <IconButton
          icon="export-close"
          data-sd="export-close"
          aria-label="Close export dialog"
          onClick={dismiss}
        />
      </header>
      <div className="export-content">
        <fieldset className="export-formats">
          <legend>Download</legend>
          <div className="export-format-grid">
            {formats.map((format) => (
              <label
                key={format.id}
                className="export-format"
                data-selected={selected.includes(format.id)}
              >
                <Checkbox
                  data-sd={`export-format-${format.id}`}
                  aria-label={format.name}
                  aria-describedby={`format-${format.id}-description`}
                  checked={selected.includes(format.id)}
                  disabled={busy}
                  onChange={(event) => select(format.id, event.target.checked)}
                />
                <span className="export-format-copy">
                  <span className="export-format-name">
                    {format.name}
                    {'agent' in format ? (
                      <Badge tone="agent" dot={false}>
                        Agent
                      </Badge>
                    ) : null}
                  </span>
                  <span id={`format-${format.id}-description`}>
                    {format.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <aside
          className="export-targets"
          aria-label="Sharing and hosting options"
        >
          <h3>Publish</h3>
          <section
            className="export-target export-local-target"
            aria-label="Local link"
          >
            <div className="export-target-title">
              <Icon name="export-link" />
              <div>
                <h4>Local link</h4>
                <p>This browser only</p>
              </div>
              <Toggle
                data-sd="export-link-private"
                on={false}
                aria-label="Public links require a server workspace"
              />
            </div>
            <div className="export-local-actions">
              <Button
                kind="ghost"
                size="s"
                icon="export-copy"
                data-sd="export-copy-link"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(`${location.origin}/g/${guide.id}`)
                    .then(() =>
                      message(
                        'Local guide link copied. It opens only where this guide is stored.',
                      ),
                    )
                    .catch(() =>
                      message(
                        'Clipboard unavailable. The local guide URL is in the address bar.',
                        true,
                      ),
                    )
                }}
              >
                Copy local link
              </Button>
              <details
                ref={copyMenu}
                className="export-copy-menu"
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && event.currentTarget.open) {
                    event.preventDefault()
                    event.stopPropagation()
                    event.currentTarget.open = false
                    event.currentTarget.querySelector('summary')?.focus()
                  }
                }}
              >
                <summary
                  className="sd-button"
                  data-kind="ghost"
                  data-size="s"
                  data-sd="export-copy-menu"
                >
                  <Icon name="code-small" />
                  Copy text
                </summary>
                <div role="group" aria-label="Clipboard formats">
                  <Button
                    kind="ghost"
                    size="s"
                    data-sd="export-copy-markdown"
                    disabled={busy}
                    onClick={copyMarkdown}
                  >
                    Copy Markdown text
                  </Button>
                  <Button
                    kind="ghost"
                    size="s"
                    data-sd="export-copy-rich"
                    disabled={busy}
                    onClick={() => run('rich')}
                  >
                    Copy rich text and images
                  </Button>
                  <Button
                    kind="ghost"
                    size="s"
                    data-sd="export-copy-html"
                    disabled={busy}
                    onClick={() => run('copy')}
                  >
                    Copy HTML source
                  </Button>
                </div>
              </details>
              <span>Private</span>
            </div>
          </section>
          <section
            className="export-target export-host-target"
            aria-label="Files for GitHub Pages"
          >
            <div className="export-target-title">
              <Icon name="export-github" />
              <div>
                <h4>GitHub Pages</h4>
                <p>Files for your repository</p>
              </div>
              <Badge tone="neutral">Files only</Badge>
            </div>
            <label className="export-host-option">
              <Checkbox
                data-sd="export-host-documents"
                aria-label="Include HTML, JSON and Markdown"
                checked={hostSet.every((format) => selected.includes(format))}
                disabled={busy}
                onChange={(event) => {
                  const next = new Set(selected)
                  for (const format of hostSet)
                    if (event.target.checked) next.add(format)
                    else next.delete(format)
                  navigate(exportUrl(guide.id, search, [...next]), true)
                }}
              />
              <span>HTML, JSON and Markdown</span>
            </label>
            <label className="export-host-option">
              <Checkbox
                data-sd="export-host-replay"
                aria-label="Include replay.spec.ts"
                checked={selected.includes('playwright')}
                disabled={busy}
                onChange={(event) => select('playwright', event.target.checked)}
              />
              <span>Include replay.spec.ts</span>
            </label>
            <label className="export-host-option">
              <Checkbox
                data-sd="export-host-skill"
                aria-label="Include SKILL.md"
                checked={selected.includes('skill')}
                disabled={busy}
                onChange={(event) => select('skill', event.target.checked)}
              />
              <span>Include SKILL.md</span>
            </label>
            <p className="export-host-note">
              Downloads do not publish your guide.
            </p>
          </section>
          <section
            className="export-target export-cloud-target"
            aria-label="Files for Cloudflare Pages"
          >
            <div className="export-target-title">
              <Icon name="export-cloud" />
              <h4>Cloudflare Pages</h4>
              <Button
                kind="ghost"
                size="s"
                data-sd="export-host-html"
                aria-pressed={selected.includes('html')}
                disabled={busy}
                onClick={() => select('html', !selected.includes('html'))}
              >
                Select HTML
              </Button>
            </div>
          </section>
        </aside>
      </div>
      {feedback ? (
        <div
          className="export-feedback"
          role={failed ? 'alert' : 'status'}
          data-sd="export-feedback"
        >
          {feedback}
          {busy ? (
            <Button
              kind="ghost"
              size="s"
              data-sd="export-cancel-job"
              onClick={() => {
                job.current?.abort()
                message('Export cancelled. Your guide was kept.')
              }}
            >
              Cancel export
            </Button>
          ) : null}
        </div>
      ) : null}
      <footer className="export-footer">
        <div className="export-redaction-state" data-open={open > 0}>
          <Icon name="export-shield" />
          <span>
            {open
              ? `${open} open items will be masked for export`
              : '0 open redaction items'}
          </span>
        </div>
        <Button
          kind="secondary"
          icon="export-download"
          data-sd="export-download"
          disabled={busy || !downloads.length}
          onClick={() => run('download')}
        >
          Download {downloads.length}{' '}
          {downloads.length === 1 ? 'format' : 'formats'}
        </Button>
        <Button
          icon="download"
          data-sd="export-print"
          disabled={busy || !selected.includes('pdf')}
          onClick={() => run('print')}
        >
          Print PDF
        </Button>
      </footer>
    </dialog>
  )
}
