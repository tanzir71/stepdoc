import { useEffect, useState } from 'react'
import { Badge, Button, Icon, Logo, StepPin } from '@stepdoc/ui'
import { browser } from 'wxt/browser'
import type { GuideRun } from './guide-run'
import './guide-panel.css'

export function GuidePanel({ run }: { run: GuideRun }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [activity, setActivity] = useState<string[]>([])
  const running = run.phase === 'running'
  const saving = run.phase === 'saving'
  const message = running
    ? `Step ${run.index + 1} of ${run.steps.length}. ${run.target.reason === 'matched' ? 'Target found.' : 'Target unavailable; confirm manually or skip.'}`
    : run.phase === 'complete'
      ? `Walkthrough ${run.report?.status === 'passed' ? 'completed' : 'ended with incomplete steps'}. Report saved locally.`
      : run.phase === 'conflict'
        ? 'The guide changed. Its newer version was not overwritten.'
        : saving
          ? 'Saving walkthrough report…'
          : 'Report is retained. Retry saving.'
  const status = notice || message
  useEffect(() => {
    setNotice('')
    setActivity((items) => [...items.slice(-99), message])
  }, [message])
  async function action(
    action: 'back' | 'skip' | 'confirm' | 'stop' | 'retry' | 'dismiss',
  ) {
    setBusy(true)
    try {
      const result = await browser.runtime.sendMessage({
        type: 'GUIDE_CONTROL',
        runId: run.runId,
        sequence: run.sequence,
        action,
      })
      if (!result.ok) throw new Error()
    } catch {
      setNotice('The walkthrough changed. Refresh the panel and retry.')
      setActivity((items) => [...items, 'Walkthrough action could not finish.'])
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="capture-panel guide-panel">
      <header className="capture-header">
        <h1 className="sd-sr-only">StepDoc Guide Me</h1>
        <Logo />
        <Badge tone="accent">Guide Me</Badge>
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
      <main className="capture-main">
        <h2 className="guide-panel-title">{run.title}</h2>
        <div className="guide-progress">
          <progress
            max={run.steps.length}
            value={running ? run.index + 1 : run.steps.length}
            aria-label="Walkthrough progress"
          />
          <span>
            {Math.min(run.index + 1, run.steps.length)} of {run.steps.length}
          </span>
        </div>
        <ol className="guide-panel-steps">
          {run.steps.map((step, i) => (
            <li
              key={step.id}
              id={`step-${i + 1}`}
              data-sd-step={i + 1}
              aria-current={running && i === run.index ? 'step' : undefined}
              data-outcome={run.outcomes[i] ?? 'pending'}
            >
              {run.outcomes[i] === 'matched' ||
              run.outcomes[i] === 'confirmed' ? (
                <Icon name="guide-completed" />
              ) : (
                <StepPin>{i + 1}</StepPin>
              )}
              <span>
                {step.title}
                {run.outcomes[i] === 'confirmed' ? (
                  <small>Manually confirmed</small>
                ) : run.outcomes[i] === 'skipped' ? (
                  <small>Skipped</small>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
        <aside className="guide-hint" aria-label="Matching information">
          <Icon name="guide-target" />
          <p>
            {running
              ? 'Advances on a matching interaction. Matching uses role + name first, then selectors. Typed values are never read or compared.'
              : `Report runner: guide-me. ${run.outcomes.filter((value) => value === 'confirmed').length} steps manually confirmed.`}
          </p>
        </aside>
        {running ? (
          <div className="capture-actions">
            <Button
              kind="ghost"
              size="s"
              data-sd="guide-me-back"
              disabled={busy || run.index === 0}
              onClick={() => void action('back')}
            >
              Back
            </Button>
            <Button
              kind="secondary"
              size="s"
              data-sd="guide-me-skip"
              disabled={busy}
              onClick={() => void action('skip')}
            >
              Skip
            </Button>
            <Button
              size="s"
              data-sd="guide-me-confirm"
              icon="guide-check"
              disabled={busy}
              onClick={() => void action('confirm')}
            >
              I did it
            </Button>
          </div>
        ) : null}
      </main>
      <footer className="capture-footer">
        <p role="status">{status}</p>
        <nav aria-label="Guide Me">
          <a
            href={`app.html?route=${encodeURIComponent(`/g/${run.guideId}/edit`)}`}
            target="_blank"
            data-sd="guide-me-editor"
          >
            Open editor
          </a>
          <Button
            kind="ghost"
            size="s"
            data-sd="guide-me-close"
            disabled={busy || saving}
            onClick={() => void action(running ? 'stop' : 'dismiss')}
          >
            {running ? 'End walkthrough' : 'Back to capture'}
          </Button>
        </nav>
        {run.phase === 'save-error' ? (
          <Button
            data-sd="guide-me-retry"
            disabled={busy}
            onClick={() => void action('retry')}
          >
            Retry saving report
          </Button>
        ) : null}
      </footer>
      <aside className="capture-activity" aria-label="Guide Me activity">
        <details>
          <summary>Activity log</summary>
          <ol>
            {activity.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ol>
        </details>
      </aside>
    </div>
  )
}
