'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Guide, Step } from '@/lib/types'
import { ImageEditor } from './image-editor'

export function Editor({ initial }: { initial: Guide }) {
  const [guide, setGuide] = useState(initial)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [toast, setToast] = useState('')
  const [active, setActive] = useState(0)
  const first = useRef(true)

  const payload = useCallback(
    (value: Guide) => ({
      title: value.title,
      description: value.description,
      isPublic: value.is_public,
      steps: value.steps.map((step, i) => ({
        id: step.id,
        position: i,
        type: step.type,
        text: step.text,
        pageUrl: step.page_url,
        screenshotPath: step.screenshot_path,
        renderedPath: step.rendered_path,
        click: step.click,
        elementMeta: step.element_meta,
        edits: step.edits,
      })),
    }),
    [],
  )

  const saveNow = useCallback(async () => {
    setSaveState('saving')
    try {
      const response = await fetch(`/api/guides/${guide.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload(guide)),
      })
      if (!response.ok) throw Error(await response.text())
      setSaveState('saved')
      return true
    } catch {
      setSaveState('error')
      setToast('Could not save changes')
      return false
    }
  }, [guide, payload])

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('saving')
    const timer = setTimeout(() => void saveNow(), 700)
    return () => clearTimeout(timer)
  }, [guide, saveNow])

  const update = useCallback((id: string, patch: Partial<Step>) => {
    setGuide((value) => ({ ...value, steps: value.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)) }))
  }, [])

  const remove = useCallback((id: string) => {
    if (confirm('Delete this step?')) setGuide((value) => ({ ...value, steps: value.steps.filter((step) => step.id !== id) }))
  }, [])

  function drag(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return
    setGuide((value) => {
      const from = value.steps.findIndex((step) => step.id === event.active.id)
      const to = value.steps.findIndex((step) => step.id === event.over!.id)
      return { ...value, steps: arrayMove(value.steps, from, to) }
    })
  }

  function add(type: Step['type']) {
    const step: Step = {
      id: crypto.randomUUID(),
      guide_id: guide.id,
      position: guide.steps.length,
      type,
      text: type === 'section' ? 'New section' : 'Describe this step',
      page_url: null,
      screenshot_path: null,
      rendered_path: null,
      click: null,
      element_meta: null,
      edits: { blur: [], crop: null, annotations: [] },
      created_at: new Date().toISOString(),
    }
    setGuide((value) => ({ ...value, steps: [...value.steps, step] }))
    setActive(guide.steps.length)
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input,textarea,select')) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((i) => Math.min(guide.steps.length - 1, i + 1))
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((i) => Math.max(0, i - 1))
      }
      if (event.key.toLowerCase() === 'e') {
        event.preventDefault()
        document.querySelector<HTMLTextAreaElement>(`[data-step-index="${active}"] textarea`)?.focus()
      }
      if (event.key === 'Delete' && guide.steps[active]) remove(guide.steps[active].id)
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [active, guide.steps, remove])

  const share = `${typeof window === 'undefined' ? '' : window.location.origin}/p/${guide.public_id}`

  return (
    <main className="wrap editor">
      <aside className="sidebar">
        <h3>Guide tools</h3>
        <p className={saveState === 'error' ? 'error-text' : 'saved'} aria-live="polite">
          {saveState === 'saving' ? 'Saving...' : saveState === 'saved' ? 'Saved' : 'Save failed'}
        </p>
        <div className="tool-stack">
          <button className="btn" onClick={() => add('manual')}>
            + Manual step
          </button>
          <button className="btn" onClick={() => add('section')}>
            + Section header
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              if (await saveNow()) {
                const response = await fetch(`/api/guides/${guide.id}/render`, { method: 'POST' })
                setToast(response.ok ? 'Images rendered' : 'Image rendering failed')
              }
            }}
          >
            Render image edits
          </button>
          <a className="btn" href={`/guides/${guide.id}`}>
            View guide
          </a>
          <button className="btn" onClick={() => {
            setSaveState('saving')
            setGuide((value) => ({ ...value, is_public: !value.is_public }))
          }}>
            {guide.is_public ? 'Revoke public link' : 'Enable public link'}
          </button>
          {guide.is_public && (
            <>
              <input readOnly aria-label="Public link" value={share} />
              <button
                className="btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(`<iframe src="${share}" width="100%" height="700"></iframe>`)
                  setToast('Embed copied')
                }}
              >
                Copy embed
              </button>
            </>
          )}
        </div>
        <p className="muted shortcuts">Arrow keys select - E edit - Delete remove</p>
      </aside>
      <section>
        <input className="titleinput" aria-label="Guide title" value={guide.title} onChange={(event) => setGuide({ ...guide, title: event.target.value })} />
        <textarea
          aria-label="Guide description"
          rows={3}
          value={guide.description}
          placeholder="Add a description..."
          onChange={(event) => setGuide({ ...guide, description: event.target.value })}
        />
        <DndContext collisionDetection={closestCenter} onDragEnd={drag}>
          <SortableContext items={guide.steps.map((step) => step.id)} strategy={verticalListSortingStrategy}>
            {guide.steps.map((step, i) => (
              <SortableStep
                key={step.id}
                guideId={guide.id}
                step={step}
                number={i + 1}
                active={active === i}
                onActivate={() => setActive(i)}
                update={update}
                remove={() => remove(step.id)}
                ensureSaved={saveNow}
                toast={setToast}
              />
            ))}
          </SortableContext>
        </DndContext>
      </section>
      {toast && (
        <div className="toast" role="status" onClick={() => setToast('')}>
          {toast}
        </div>
      )}
    </main>
  )
}

function SortableStep({
  guideId,
  step,
  number,
  active,
  onActivate,
  update,
  remove,
  ensureSaved,
  toast,
}: {
  guideId: string
  step: Step
  number: number
  active: boolean
  onActivate: () => void
  update: (id: string, patch: Partial<Step>) => void
  remove: () => void
  ensureSaved: () => Promise<boolean>
  toast: (message: string) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: step.id })
  const file = useRef<HTMLInputElement>(null)
  const imageChange = useCallback((edits: Step['edits'], click: Step['click']) => update(step.id, { edits, click }), [step.id, update])

  async function upload(image: File) {
    if (!(await ensureSaved())) return
    const form = new FormData()
    form.set('image', image)
    const response = await fetch(`/api/guides/${guideId}/steps/${step.id}/image`, { method: 'POST', body: form })
    if (!response.ok) {
      toast('Image upload failed')
      return
    }
    const data = await response.json()
    update(step.id, { screenshot_path: data.path, rendered_path: null, imageUrl: data.imageUrl })
    toast('Image uploaded')
  }

  return (
    <div
      ref={setNodeRef}
      data-step-index={number - 1}
      onClick={onActivate}
      className={`card stepedit ${active ? 'active' : ''} ${step.element_meta?.lowConfidence ? 'low' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div className="row between">
        <span className="drag" {...attributes} {...listeners}>
          Step {number} - {step.type}
        </span>
        <div className="row">
          {step.element_meta?.lowConfidence && <span className="review-badge">Review text</span>}
          <button className="btn" onClick={() => file.current?.click()}>
            Upload image
          </button>
          <input
            ref={file}
            hidden
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const selected = event.target.files?.[0]
              if (selected) void upload(selected)
            }}
          />
          <button className="btn danger" onClick={remove}>
            Delete
          </button>
        </div>
      </div>
      <textarea rows={2} aria-label={`Step ${number} text`} value={step.text} onChange={(event) => update(step.id, { text: event.target.value })} />
      {step.imageUrl && <ImageEditor src={step.imageUrl} edits={step.edits} click={step.click} onChange={imageChange} />}
    </div>
  )
}
