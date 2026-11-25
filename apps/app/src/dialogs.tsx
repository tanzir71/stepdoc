import { useRef, useState, type RefObject } from 'react'
import { Button, Input } from '@stepdoc/ui'
import type { GuideInput } from '@stepdoc/schema'
import { StorageError } from '@stepdoc/storage'
import { getStorage, changed } from './repository'
import { importGuide, libraryUrl, manualGuide, newId } from './model'
import { navigate } from './navigation'
import { useActivity } from './activity'

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
          location.pathname === '/' &&
          new URLSearchParams(location.search).get('create') === '1'
        )
          navigate(libraryUrl(location.search, { create: null }), true)
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
  const [pending, setPending] = useState<GuideInput | null>(null)
  const [busy, setBusy] = useState(false)
  const announce = useActivity()
  const save = async (guide: GuideInput, copy = false) => {
    setBusy(true)
    try {
      const adapter = await getStorage()
      await adapter.createGuide(
        copy
          ? { ...guide, id: newId(guide.title), uuid: crypto.randomUUID() }
          : guide,
      )
      changed()
      dialog.current?.close()
      setPending(null)
      announce(
        guide.steps.some((step) => step.screenshot)
          ? 'Guide data imported. Image files were not included in this JSON file.'
          : 'Guide imported on this device.',
      )
    } catch (error) {
      if (!copy && error instanceof StorageError && error.code === 'conflict') {
        setPending(guide)
        dialog.current?.showModal()
      } else
        announce('The guide could not be imported. Existing guides were kept.')
    } finally {
      setBusy(false)
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
      <input
        ref={file}
        className="sd-sr-only"
        type="file"
        accept=".json,application/json"
        aria-label="Import guide JSON"
        data-sd="library-import-file"
        onChange={(event) => {
          const input = event.currentTarget
          const selected = input.files?.[0]
          input.value = ''
          if (!selected) return
          if (selected.size > 8 * 1024 * 1024) {
            announce('Choose a guide JSON file smaller than 8 MB.')
            return
          }
          setBusy(true)
          void selected
            .text()
            .then((text) => {
              const guide = importGuide(text)
              if (!guide) {
                announce('This file is not a valid guide@1 document.')
                setBusy(false)
                return
              }
              return save(guide)
            })
            .catch(() => {
              announce('The import file could not be read.')
              setBusy(false)
            })
        }}
      />
      <dialog
        ref={dialog}
        className="app-dialog"
        aria-labelledby="import-heading"
      >
        <h2 id="import-heading">This guide is already in your library</h2>
        <p>Keep the saved guide and import this file as a separate copy.</p>
        <div className="dialog-actions">
          <Button
            data-sd="library-import-cancel"
            kind="ghost"
            onClick={() => {
              dialog.current?.close()
              setPending(null)
            }}
          >
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
