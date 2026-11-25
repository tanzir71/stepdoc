import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Icon, Input, Toggle } from '@stepdoc/ui'
import type { Guide, Locator, Step } from '@stepdoc/schema'
import {
  exportPlaywright,
  previewReplayStep,
  replayLocators,
} from '@stepdoc/core/export/playwright'
import type { EditorController } from './controller'
import {
  actions,
  changeAction,
  safePageUrl,
  strategies,
  updateTarget,
} from './model'
import { SelectField, TextField } from './fields'
import { useActivity } from '../activity'

function PageUrlField({
  url,
  origin,
  change,
  hook = 'target-url',
  label = 'Page URL',
  allowPath = false,
}: {
  url: string | null | undefined
  origin?: string
  change: (url: string | null) => void
  hook?: string
  label?: string
  allowPath?: boolean
}) {
  const [text, setText] = useState(url ?? '')
  const focused = useRef(false)
  const cleanUrl = (value: string) => {
    const text = value.trim()
    if (allowPath && text.startsWith('/') && !text.startsWith('//'))
      return text.split(/[?#]/)[0] || null
    return safePageUrl(text, origin)
  }
  useEffect(() => {
    if (!focused.current) setText(url ?? '')
  }, [url])
  return (
    <label className="sd-input editor-field">
      <span className="sd-input-label">{label}</span>
      <input
        data-sd={hook}
        aria-label={label}
        value={text}
        onFocus={() => {
          focused.current = true
        }}
        onChange={(event) => {
          const value = event.target.value
          setText(value)
          const clean = cleanUrl(value)
          if (clean || !value.trim()) change(clean)
        }}
        onBlur={() => {
          focused.current = false
          const clean = cleanUrl(text)
          setText(clean ?? '')
          change(clean)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
      />
    </label>
  )
}

export function TargetPanel({
  guide,
  step,
  controller,
}: {
  guide: Guide
  step: Step
  controller: EditorController
}) {
  const announce = useActivity()
  const locatorDialog = useRef<HTMLDialogElement>(null)
  const variableDialog = useRef<HTMLDialogElement>(null)
  const [locator, setLocator] = useState<{
    index: number
    value: Locator
    primary?: boolean
  }>({
    index: -1,
    value: { strategy: 'role', value: 'button', exact: true },
  })
  const edit = (change: (step: Step, guide: Guide) => void) =>
    controller.edit((doc) =>
      change(doc.steps.find((item) => item.id === step.id)!, doc),
    )
  const rawLocators = step.target?.locators ?? []
  const locators = replayLocators(step.target)
  const expected = step.expect?.visible
    ? 'visible'
    : step.expect?.hidden
      ? 'hidden'
      : step.expect?.text
        ? 'text'
        : step.expect?.urlMatches !== undefined
          ? 'url'
          : 'none'
  let preview = 'This step has no replay instruction.'
  try {
    preview = previewReplayStep(guide, step.id)
  } catch {
    /* Invalid imports never reach a code generator unchecked. */
  }
  return (
    <>
      <SelectField
        label="Action"
        icon="pointer-small"
        hook="target-action"
        value={
          step.action ??
          (step.type === 'navigate'
            ? 'navigate'
            : step.type === 'assert'
              ? 'assert'
              : 'manual')
        }
        onChange={(value) =>
          edit((_step, doc) =>
            changeAction(doc, step.id, value as NonNullable<Step['action']>),
          )
        }
      >
        {!step.action ? (
          <option value="manual" disabled>
            {step.type === 'section'
              ? 'Section heading'
              : step.type === 'manual'
                ? 'Manual instruction'
                : 'Choose an action'}
          </option>
        ) : null}
        {actions.map((action) => (
          <option key={action}>{action}</option>
        ))}
      </SelectField>
      <section className="target-group" aria-labelledby="target-heading">
        <div className="inspector-label">
          <h2 id="target-heading">Target</h2>
          <span>Replay order</span>
        </div>
        <ol className="locator-list" aria-label="Ordered target locators">
          {locators.map((item, index) => (
            <li key={index}>
              <button
                type="button"
                className="locator-entry"
                data-sd="target-locator-edit"
                aria-label={`Edit locator ${index + 1}: ${item.strategy} ${item.value}`}
                onClick={() => {
                  const rawIndex = rawLocators.findIndex(
                    (raw) =>
                      raw.strategy === item.strategy &&
                      raw.value === item.value &&
                      raw.name === item.name &&
                      raw.exact === item.exact,
                  )
                  setLocator({
                    index: rawIndex,
                    value: structuredClone(item),
                    primary:
                      item.strategy === 'role' &&
                      item.value === step.target?.role &&
                      item.name === step.target?.name,
                  })
                  locatorDialog.current?.showModal()
                }}
              >
                <span>{item.strategy}</span>
                <code>
                  {item.strategy === 'role'
                    ? `${item.value}${item.name ? ` "${item.name}"` : ''}`
                    : item.value}
                </code>
                {item.unique === true ? (
                  <Badge tone="success" dot={false}>
                    Unique
                  </Badge>
                ) : item.strategy === 'css' ||
                  item.strategy === 'xpath' ||
                  item.unique === false ? (
                  <Badge tone="warning" dot={false}>
                    Fragile
                  </Badge>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
        <Button
          size="s"
          kind="ghost"
          icon="plus-small"
          data-sd="target-locator-add"
          onClick={() => {
            setLocator({
              index: -1,
              value: { strategy: 'role', value: 'button', exact: true },
            })
            locatorDialog.current?.showModal()
          }}
        >
          Add locator
        </Button>
      </section>

      <PageUrlField
        url={step.url}
        origin={guide.app?.origin}
        change={(value) =>
          edit((s) => {
            s.url = value
          })
        }
      />
      <div className="strip-query">
        <Toggle
          data-sd="target-strip-query"
          aria-label="Strip query strings and fragments, enforced in browser mode"
          on
          disabled
        />
        <span>Queries and fragments always removed</span>
      </div>
      {['fill', 'upload'].includes(step.action ?? '') ? (
        <>
          <SelectField
            label="Runtime input"
            hook="target-variable"
            value={
              step.value?.kind === 'variable' || step.value?.kind === 'secret'
                ? step.value.variable
                : ''
            }
            onChange={(name) =>
              edit((s) => {
                const variable = guide.variables.find((v) => v.name === name)!
                s.value = { kind: variable.kind, variable: name }
              })
            }
          >
            {guide.variables.map((variable) => (
              <option
                key={variable.name}
                value={variable.name}
              >{`{${variable.kind}: ${variable.name}}`}</option>
            ))}
          </SelectField>
          <p className="field-help">
            Runtime inputs are supplied by the replay runner. No field values
            are stored.
          </p>
          <Button
            kind="ghost"
            size="s"
            data-sd="target-variable-add"
            onClick={() => variableDialog.current?.showModal()}
          >
            Add variable
          </Button>
        </>
      ) : null}
      {step.action === 'select' ? (
        <TextField
          label="Selected option label"
          hook="target-option"
          value={step.value?.kind === 'literal' ? step.value.literal : ''}
          onChange={(value) =>
            edit((s) => {
              s.value = { kind: 'literal', literal: value }
            })
          }
        />
      ) : null}
      {step.action === 'press' ? (
        <TextField
          label="Key name"
          hook="target-key"
          value={step.key ?? 'Enter'}
          required
          onChange={(value) =>
            edit((s) => {
              s.key = value
            })
          }
        />
      ) : null}
      <section className="expectation-group">
        <h2>Expect after this step</h2>
        <details>
          <summary data-sd="target-expect-open">
            <Icon name="check-small" />
            <span>
              {expected === 'visible' || expected === 'hidden'
                ? `${step.expect?.[expected]?.role ?? 'target'} "${step.expect?.[expected]?.name ?? ''}" is ${expected}`
                : expected === 'url'
                  ? `URL starts with ${step.expect?.urlMatches ?? ''}`
                  : expected === 'text'
                    ? `Contains "${step.expect?.text?.contains ?? ''}"`
                    : 'No expectation'}
            </span>
          </summary>
          <SelectField
            label="Expect after this step"
            hook="target-expect-kind"
            value={expected}
            onChange={(value) =>
              edit((s) => {
                s.expect =
                  value === 'none'
                    ? undefined
                    : value === 'url'
                      ? { urlMatches: '/' }
                      : value === 'text'
                        ? { text: { contains: '' } }
                        : { [value]: { role: 'dialog', name: '' } }
              })
            }
          >
            {['none', 'visible', 'hidden', 'text', 'url'].map((value) => (
              <option key={value} value={value}>
                {value === 'none'
                  ? 'No expectation'
                  : value === 'url'
                    ? 'URL prefix'
                    : value === 'text'
                      ? 'Visible text'
                      : `${value === 'visible' ? 'Visible' : 'Hidden'} target`}
              </option>
            ))}
          </SelectField>
          {expected === 'visible' || expected === 'hidden' ? (
            <>
              <TextField
                label="Expected target role"
                hook="target-expect-role"
                value={step.expect?.[expected]?.role ?? ''}
                onChange={(value) =>
                  edit((s) => {
                    s.expect = {
                      ...s.expect,
                      [expected]: {
                        ...s.expect?.[expected],
                        role: value || undefined,
                      },
                    }
                  })
                }
              />
              <TextField
                label="Expected target name"
                hook="target-expect-name"
                value={step.expect?.[expected]?.name ?? ''}
                onChange={(value) =>
                  edit((s) => {
                    s.expect = {
                      ...s.expect,
                      [expected]: {
                        ...s.expect?.[expected],
                        name: value || undefined,
                      },
                    }
                  })
                }
              />
            </>
          ) : expected === 'text' ? (
            <TextField
              label="Expected visible text"
              hook="target-expect-text"
              value={step.expect?.text?.contains ?? ''}
              onChange={(value) =>
                edit((s) => {
                  s.expect = { text: { contains: value } }
                })
              }
            />
          ) : expected === 'url' ? (
            <PageUrlField
              label="Expected URL prefix"
              hook="target-expect-url"
              allowPath
              url={step.expect?.urlMatches}
              change={(value) =>
                edit((s) => {
                  s.expect = { urlMatches: value ?? '' }
                })
              }
            />
          ) : null}
        </details>
      </section>
      <div className="target-buttons">
        <Button
          size="s"
          kind="secondary"
          icon="target-button-small"
          data-sd="target-open-live"
          disabled={!safePageUrl(step.url ?? '', guide.app?.origin)}
          onClick={() => {
            const url = safePageUrl(step.url ?? '', guide.app?.origin)
            if (url) window.open(url, '_blank', 'noopener,noreferrer')
          }}
        >
          Open live page
        </Button>
        <Button
          size="s"
          kind="ghost"
          icon="code-small"
          data-sd="target-copy-playwright"
          onClick={() => {
            try {
              const code = exportPlaywright({
                ...guide,
                steps: [{ ...step, screenshot: undefined }],
              })
              void navigator.clipboard
                .writeText(code)
                .then(() =>
                  announce('A complete replay test for this step was copied.'),
                )
                .catch(() =>
                  announce(
                    'Clipboard unavailable. Download the guide JSON to keep this step.',
                  ),
                )
            } catch {
              announce(
                'This step could not be exported. Check its target and runtime inputs.',
              )
            }
          }}
        >
          Copy Playwright
        </Button>
      </div>
      <pre
        className="generated-replay"
        aria-label="Generated replay instruction"
      >
        {preview}
      </pre>
      <details className="target-details">
        <summary data-sd="target-details-open">
          Role and accessible name
        </summary>
        <TextField
          label="Target role"
          hook="target-role"
          value={step.target?.role ?? ''}
          onChange={(value) => edit((s) => updateTarget(s, 'role', value))}
        />
        <TextField
          label="Target name"
          hook="target-name"
          value={step.target?.name ?? ''}
          onChange={(value) => edit((s) => updateTarget(s, 'name', value))}
        />
      </details>
      <dialog
        ref={locatorDialog}
        className="app-dialog"
        aria-labelledby="locator-dialog-title"
      >
        <h2 id="locator-dialog-title">
          {locator.index < 0 ? 'Add' : 'Edit'} locator
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            edit((s) => {
              s.target ??= {}
              const next = [...(s.target.locators ?? [])]
              const value = { ...locator.value, unique: undefined }
              if (
                locator.primary ||
                (value.strategy === 'role' && !s.target.role && !s.target.name)
              ) {
                s.target.role =
                  value.strategy === 'role' ? value.value : undefined
                s.target.name =
                  value.strategy === 'role' ? value.name : undefined
              }
              if (locator.index < 0) next.push(value)
              else next[locator.index] = value
              s.target.locators = next
              s.lowConfidence = true
            })
            locatorDialog.current?.close()
          }}
        >
          <SelectField
            label="Locator strategy"
            hook="locator-strategy"
            value={locator.value.strategy}
            onChange={(value) =>
              setLocator((prev) => ({
                ...prev,
                value: {
                  ...prev.value,
                  strategy: value as Locator['strategy'],
                },
              }))
            }
          >
            {strategies.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </SelectField>
          <Input
            label="Locator value"
            data-sd="locator-value"
            required
            maxLength={2000}
            value={locator.value.value}
            onChange={(event) =>
              setLocator((prev) => ({
                ...prev,
                value: { ...prev.value, value: event.target.value },
              }))
            }
          />
          {locator.value.strategy === 'role' ? (
            <Input
              label="Locator accessible name"
              data-sd="locator-name"
              maxLength={1000}
              value={locator.value.name ?? ''}
              onChange={(event) =>
                setLocator((prev) => ({
                  ...prev,
                  value: { ...prev.value, name: event.target.value },
                }))
              }
            />
          ) : null}
          <label className="native-check">
            <input
              type="checkbox"
              data-sd="locator-exact"
              checked={locator.value.exact}
              onChange={(event) =>
                setLocator((prev) => ({
                  ...prev,
                  value: { ...prev.value, exact: event.target.checked },
                }))
              }
            />
            Exact match
          </label>
          <div className="dialog-actions">
            {locator.index >= 0 || locator.primary ? (
              <Button
                kind="danger"
                data-sd="locator-delete"
                onClick={() => {
                  edit((s) => {
                    s.target!.locators = rawLocators.filter(
                      (_, index) => index !== locator.index,
                    )
                    if (locator.primary) {
                      delete s.target!.role
                      delete s.target!.name
                    }
                    s.lowConfidence = true
                  })
                  locatorDialog.current?.close()
                }}
              >
                Delete
              </Button>
            ) : null}
            <Button
              kind="ghost"
              data-sd="locator-cancel"
              onClick={() => locatorDialog.current?.close()}
            >
              Cancel
            </Button>
            <Button type="submit" data-sd="locator-save">
              Save locator
            </Button>
          </div>
        </form>
      </dialog>
      <dialog
        ref={variableDialog}
        className="app-dialog"
        aria-labelledby="variable-heading"
      >
        <h2 id="variable-heading">Add runtime input</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const name = String(data.get('name'))
            if (guide.variables.some((v) => v.name === name)) {
              announce('That variable name is already in use.')
              return
            }
            const kind = data.get('kind') === 'variable' ? 'variable' : 'secret'
            edit((s, doc) => {
              doc.variables.push({ name, kind, type: 'string' })
              s.value = { kind, variable: name }
            })
            variableDialog.current?.close()
            event.currentTarget.reset()
          }}
        >
          <Input
            data-sd="variable-name"
            label="Variable name"
            name="name"
            required
            pattern="[a-z][a-z0-9_]{0,40}"
            maxLength={41}
          />
          <label className="sd-input editor-field">
            <span className="sd-input-label">Kind</span>
            <select
              name="kind"
              data-sd="variable-kind"
              aria-label="Variable kind"
              defaultValue="secret"
            >
              <option value="secret">Secret</option>
              <option value="variable">Variable</option>
            </select>
          </label>
          <div className="dialog-actions">
            <Button
              kind="ghost"
              data-sd="variable-cancel"
              onClick={() => variableDialog.current?.close()}
            >
              Cancel
            </Button>
            <Button type="submit" data-sd="variable-save">
              Add input
            </Button>
          </div>
        </form>
      </dialog>
    </>
  )
}
