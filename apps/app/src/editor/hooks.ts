import { useEffect, useState, useSyncExternalStore } from 'react'
import { getStorage, changed } from '../repository'
import { EditorController } from './controller'
import { ImageProcessor, materializeImages } from './images'

export interface EditorRuntime {
  controller: EditorController
  processor: ImageProcessor
}
export function useEditor(id: string, attempt = 0) {
  const [state, setState] = useState<{
    id: string
    runtime?: EditorRuntime
    failed?: boolean
  }>({ id })
  useEffect(() => {
    let active = true
    let processor: ImageProcessor | undefined
    void getStorage()
      .then(async (adapter) => {
        const guide = await adapter.getGuide(id)
        if (!active) return
        processor = new ImageProcessor()
        const controller = new EditorController(
          adapter,
          guide,
          (draft, saved, force) =>
            materializeImages(adapter, processor!, draft, saved, force),
        )
        setState({ id, runtime: { controller, processor } })
      })
      .catch(() => {
        if (active) setState({ id, failed: true })
      })
    return () => {
      active = false
      processor?.close()
    }
  }, [id, attempt])
  return state.id === id ? state : { id }
}
export function useEditorState(controller: EditorController, enabled = true) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  )
  useEffect(() => {
    if (!enabled || !state.dirty || state.error || state.saving) return
    const timer = setTimeout(() => {
      void controller.flush().then((ok) => {
        if (ok) changed()
      })
    }, 600)
    return () => clearTimeout(timer)
  }, [
    controller,
    state.dirty,
    state.error,
    state.saving,
    state.revision,
    enabled,
  ])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (controller.snapshot().dirty) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [controller])
  return state
}
