import { useEffect, useState } from 'react'
import { Button, Badge } from '@stepdoc/ui'
import type { Guide } from '@stepdoc/schema'
import { exportGuideJson } from '@stepdoc/core/export/json'
import { getStorage } from './repository'
import { useBlob } from './hooks'
import { useActivity } from './activity'
import { StatePanel } from './library'

function StepImage({ step }: { step: Guide['steps'][number] }) {
  const url = useBlob(step.screenshot?.rendered ?? null)
  if (!step.screenshot) return null
  const alt =
    step.screenshot.alt ||
    `The ${step.target?.name || step.title}${step.target?.role ? ` ${step.target.role}` : ''}`
  return url ? (
    <figure>
      <img
        src={url}
        alt={alt}
        width={step.screenshot.width}
        height={step.screenshot.height}
      />
      <figcaption>{alt}</figcaption>
    </figure>
  ) : (
    <p className="image-unavailable">Image not available on this device.</p>
  )
}
export function Preview({ id, refresh }: { id: string; refresh: number }) {
  const [state, setState] = useState<{
    id: string
    guide?: Guide
    failed: boolean
  }>({ id, failed: false })
  const announce = useActivity()
  useEffect(() => {
    let active = true
    void getStorage()
      .then((adapter) => adapter.getGuide(id))
      .then((guide) => {
        if (active) setState({ id, guide, failed: false })
      })
      .catch(() => {
        if (active) setState({ id, failed: true })
      })
    return () => {
      active = false
    }
  }, [id, refresh])
  const guide = state.id === id ? state.guide : undefined
  return (
    <>
      <header className="preview-header">
        <a href="/" data-sd="guide-library">
          ← Library
        </a>
        {guide ? (
          <Button
            data-sd="guide-download-json"
            kind="secondary"
            onClick={() => {
              try {
                const blob = new Blob([exportGuideJson(guide)], {
                  type: 'application/json',
                })
                const url = URL.createObjectURL(blob)
                const anchor = document.createElement('a')
                anchor.href = url
                anchor.download = `${guide.id}.json`
                anchor.click()
                setTimeout(() => URL.revokeObjectURL(url), 1000)
                announce(
                  'Guide data downloaded. Image files are stored separately.',
                )
              } catch {
                announce('The guide data could not be exported.')
              }
            }}
          >
            Download guide.json
          </Button>
        ) : null}
      </header>
      <main id="main" tabIndex={-1} className="preview-main">
        {!guide ? <h1 className="sd-sr-only">Saved guide</h1> : null}
        {guide ? (
          <article className="guide-preview">
            <header>
              <Badge tone="neutral">Stored on this device</Badge>
              <h1>{guide.title}</h1>
              {guide.description ? <p>{guide.description}</p> : null}
              <p className="guide-metadata">
                {guide.steps.length} steps · Version {guide.version} ·{' '}
                {guide.schema}
              </p>
            </header>
            {guide.preconditions.length ? (
              <aside aria-label="Preconditions">
                <h2>Before you begin</h2>
                <ul>
                  {guide.preconditions.map((text, index) => (
                    <li key={index}>{text}</li>
                  ))}
                </ul>
              </aside>
            ) : null}
            <ol className="preview-steps">
              {[...guide.steps]
                .sort((a, b) => a.index - b.index)
                .map((step, index) => (
                  <li
                    key={step.id}
                    id={`step-${index + 1}`}
                    data-sd-step={index + 1}
                  >
                    <h2>{step.title}</h2>
                    {step.description ? <p>{step.description}</p> : null}
                    <StepImage step={step} />
                  </li>
                ))}
            </ol>
          </article>
        ) : state.id === id && state.failed ? (
          <StatePanel title="Guide unavailable">
            This guide was not found or could not be read on this device. Return
            to the library to choose another guide.
          </StatePanel>
        ) : (
          <p role="status">Loading guide…</p>
        )}
      </main>
    </>
  )
}
