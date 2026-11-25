import { useEffect, useRef, useState, type RefObject } from 'react'
import { Button, Input } from '@stepdoc/ui'
import type { GuideInput } from '@stepdoc/schema'
import { StorageError } from '@stepdoc/storage'
import { getStorage, changed } from './repository'
import { importGuide, libraryUrl, manualGuide, newId } from './model'
import { navigate } from './navigation'
import { routeLocation } from './app-url'
import { useActivity } from './activity'
import type { ParsedBundle } from './exports/client'

type PendingImport =
  | { kind: 'json'; guide: GuideInput }
  | { kind: 'bundle'; bundle: ParsedBundle }

export function CreateDialog({
  dialog,
}: {
  dialog: RefObject<HTMLDialogElement | null>
}) {
  const [title, setTitle] = useState('')
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const announce = useActivity()
  return (
    <dialog
      ref={dialog}
      className="app-dialog"
      aria-labelledby="create-heading"
      onClose={() => {
        setError(null)
        if (
          routeLocation().pathname === '/' &&
          routeLocation().searchParams.get('create') === '1'
        )
          navigate(libraryUrl(routeLocation().search, { create: null }), true)
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (busy) return
          setBusy(true)
          setError(null)
          void getStorage()
            .then((adapter) =>
              adapter.createGuide(manualGuide(title, instruction)),
            )
            .then((guide) => {
              changed()
              setTitle('')
              setInstruction('')
              dialog.current?.close()
              announce('Guide created on this device.')
              navigate(`/g/${guide.id}`)
            })
            .catch(() => {
              setError('The guide could not be saved. Your text is still here.')
              announce('Guide could not be saved.')
            })
            .finally(() => setBusy(false))
        }}
      >
        <div className="dialog-header">
          <h2 id="create-heading">Create a guide</h2>
        </div>
        <p>Start with a title and your first instruction.</p>
        <Input
          data-sd="guide-create-title"
          label="Guide title"
          required
          maxLength={200}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          autoFocus
        />
        <Input
          data-sd="guide-create-instruction"
          label="First instruction"
          required
          maxLength={1000}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
        {error ? (
          <p role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <Button
            data-sd="guide-create-cancel"
            kind="ghost"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </Button>
          <Button
            data-sd="guide-create-submit"
            type="submit"
            disabled={busy || !title.trim() || !instruction.trim()}
          >
            {busy ? 'Saving…' : 'Create guide'}
          </Button>
        </div>
      </form>
    </dialog>
  )
}

export function ImportControl() {
  const file = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const [pending, setPending] = useState<PendingImport | null>(null)
  const [busy, setBusy] = useState(false)
  const announce = useActivity()
  const job = useRef<AbortController | null>(null)
  useEffect(() => () => job.current?.abort(), [])
  const cancel = () => {
    job.current?.abort()
    if (busy) announce('Import cancelled. Existing guides were kept.')
    dialog.current?.close()
    setPending(null)
  }
  const save = async (
    input: PendingImport,
    copy = false,
    current?: AbortController,
  ) => {
    if (!current && job.current) return
    const controller = current ?? new AbortController()
    job.current = controller
    setBusy(true)
    try {
      const adapter = await getStorage()
      if (controller.signal.aborted) return
      if (input.kind === 'bundle') {
        const { saveBundle } = await import('./exports/client')
        await saveBundle(adapter, input.bundle, copy, controller.signal)
      } else {
        const guide = input.guide
        const saved = await adapter.createGuide(
          copy
            ? { ...guide, id: newId(guide.title), uuid: crypto.randomUUID() }
            : guide,
        )
        if (controller.signal.aborted) {
          await adapter.deleteGuide(saved.id)
          return
        }
      }
      if (controller.signal.aborted) return
      changed()
      dialog.current?.close()
      setPending(null)
      announce(
        input.kind === 'bundle'
          ? 'Guide and redacted images imported on this device.'
          : input.guide.steps.some((step) => step.screenshot)
            ? 'Guide data imported. Image files were not included in this JSON file.'
            : 'Guide imported on this device.',
      )
    } catch (error) {
      if (controller.signal.aborted) return
      if (!copy && error instanceof StorageError && error.code === 'conflict') {
        setPending(input)
        dialog.current?.showModal()
      } else
        announce('The guide could not be imported. Existing guides were kept.')
    } finally {
      if (job.current === controller) {
        job.current = null
        setBusy(false)
      }
    }
  }
  return (
    <>
      <Button
        data-sd="library-import"
        kind="secondary"
        icon="upload"
        disabled={busy}
        onClick={() => file.current?.click()}
      >
        {busy ? 'Importing…' : 'Import'}
      </Button>
      {busy ? (
        <Button
          kind="ghost"
          size="s"
          data-sd="library-import-stop"
          onClick={cancel}
        >
          Cancel import
        </Button>
      ) : null}
      <input
        ref={file}
        className="sd-sr-only"
        type="file"
        accept=".json,.stepdoc,application/json,application/vnd.stepdoc+zip"
        aria-label="Import guide JSON or StepDoc bundle"
        data-sd="library-import-file"
        disabled={busy}
        onChange={(event) => {
          const input = event.currentTarget
          const selected = input.files?.[0]
          input.value = ''
          if (!selected) return
          if (job.current) return
          const bundle =
            selected.name.toLowerCase().endsWith('.stepdoc') ||
            selected.type === 'application/vnd.stepdoc+zip'
          if (selected.size > (bundle ? 256 : 8) * 1024 * 1024) {
            announce(
              bundle
                ? 'Choose a StepDoc bundle smaller than 256 MB.'
                : 'Choose a guide JSON file smaller than 8 MB.',
            )
            return
          }
          setBusy(true)
          const controller = new AbortController()
          job.current = controller
          const finished = () => {
            if (job.current === controller) {
              job.current = null
              setBusy(false)
            }
          }
          if (bundle) {
            announce('Checking the local bundle and its image hashes…')
            void import('./exports/client')
              .then(({ parseBundle }) =>
                parseBundle(selected, controller.signal),
              )
              .then((bundle) =>
                save({ kind: 'bundle', bundle }, false, controller),
              )
              .catch(() => {
                if (controller.signal.aborted) return
                announce(
                  'This bundle could not be imported. Existing guides were kept.',
                )
              })
              .finally(finished)
            return
          }
          void selected
            .text()
            .then((text) => {
              if (controller.signal.aborted) return
              const guide = importGuide(text)
              if (!guide) {
                announce('This file is not a valid guide@1 document.')
                return
              }
              return save({ kind: 'json', guide }, false, controller)
            })
            .catch(() => {
              if (controller.signal.aborted) return
              announce('The import file could not be read.')
            })
            .finally(finished)
        }}
      />
      <dialog
        ref={dialog}
        className="app-dialog"
        aria-labelledby="import-heading"
        onCancel={() => {
          job.current?.abort()
          setPending(null)
        }}
      >
        <h2 id="import-heading">This guide is already in your library</h2>
        <p>Keep the saved guide and import this file as a separate copy.</p>
        <div className="dialog-actions">
          <Button data-sd="library-import-cancel" kind="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button
            data-sd="library-import-copy"
            disabled={busy}
            onClick={() => {
              if (pending) void save(pending, true)
            }}
          >
            Import as a copy
          </Button>
        </div>
      </dialog>
    </>
  )
}
