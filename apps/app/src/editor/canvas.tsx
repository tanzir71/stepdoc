import { useEffect, useRef, useState, type PointerEvent } from 'react'
import {
  Badge,
  Button,
  ClickMarker,
  Icon,
  IconButton,
  StepPin,
} from '@stepdoc/ui'
import type { Guide, Step, Rect, Annotation } from '@stepdoc/schema'
import { clipPixelRect } from '@stepdoc/core/canvas'
import type { EditorController } from './controller'
import { imageOptions, type ImageProcessor } from './images'
import { getStorage } from '../repository'
import { TextField } from './fields'
import { visualKey, layerAtPoint, translateLayer } from './model'

type Tool = 'select' | 'blur' | 'crop' | 'arrow' | 'rectangle' | 'text' | 'pin'
const tools: {
  name: Tool
  icon: 'pointer' | 'blur' | 'crop' | 'arrow' | 'rectangle' | 'type' | 'pin'
  label: string
}[] = [
  { name: 'select', icon: 'pointer', label: 'Select layer' },
  { name: 'blur', icon: 'blur', label: 'Add blur' },
  { name: 'crop', icon: 'crop', label: 'Crop screenshot' },
  { name: 'arrow', icon: 'arrow', label: 'Add arrow' },
  { name: 'rectangle', icon: 'rectangle', label: 'Add rectangle' },
  { name: 'text', icon: 'type', label: 'Add text annotation' },
  { name: 'pin', icon: 'pin', label: 'Add pin' },
]
interface ImageState {
  key: string
  url: string
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
}
export function CanvasPanel({
  guide,
  step,
  controller,
  processor,
  upload,
  query,
  route,
}: {
  guide: Guide
  step: Step
  controller: EditorController
  processor: ImageProcessor
  upload: () => void
  query: URLSearchParams
  route: (changes: Record<string, string | null>) => void
}) {
  const [image, setImage] = useState<ImageState | null>(null)
  const [failed, setFailed] = useState(false)
  const [gesture, setGesture] = useState<{
    x: number
    y: number
    toX: number
    toY: number
  } | null>(null)
  const sequence = useRef(0)
  const frame = useRef<HTMLDivElement>(null)
  const source = step.screenshot?.original ?? step.screenshot?.rendered
  const key = visualKey(step)
  const tool: Tool = tools.some((item) => item.name === query.get('tool'))
    ? (query.get('tool') as Tool)
    : 'select'
  const selected = query.get('layer') ?? ''
  const zoom = Number(query.get('zoom'))
  const actualZoom = [25, 50, 75, 100, 150, 200].includes(zoom) ? zoom : null
  const editable = !!step.screenshot?.original
  const edit = (change: (step: Step) => void) =>
    controller.edit((doc) => change(doc.steps.find((s) => s.id === step.id)!))
  useEffect(() => {
    let active = true
    let url: string | undefined
    const current = ++sequence.current
    setFailed(false)
    if (!source) {
      setImage(null)
      return
    }
    void getStorage()
      .then(async (adapter) => {
        const file = await adapter.getBlob(source)
        if (step.screenshot?.original) {
          const processed = await processor.process(file, {
            ...imageOptions(step),
            click: null,
          })
          return {
            file: processed.rendered.blob,
            width: processed.rendered.width,
            height: processed.rendered.height,
            sourceWidth: processed.original.width,
            sourceHeight: processed.original.height,
          }
        }
        const bitmap = await createImageBitmap(file)
        const dimensions = {
          width: bitmap.width,
          height: bitmap.height,
          sourceWidth: bitmap.width,
          sourceHeight: bitmap.height,
        }
        bitmap.close()
        return { file, ...dimensions }
      })
      .then((result) => {
        if (active && current === sequence.current) {
          url = URL.createObjectURL(result.file)
          setImage({ key, url, ...result })
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
    // key snapshots every property affecting pixels; title/selection edits do not decode images.
  }, [source, key, processor])
  const current = image?.key === key ? image : null
  const crop = step.edits?.crop
  const clippedCrop =
    crop && current
      ? clipPixelRect(crop, current.sourceWidth, current.sourceHeight)
      : null
  const origin = { x: clippedCrop?.x ?? 0, y: clippedCrop?.y ?? 0 }
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return {
      x:
        origin.x +
        (Math.max(0, Math.min(box.width, event.clientX - box.x)) *
          (current?.width ?? 1)) /
          box.width,
      y:
        origin.y +
        (Math.max(0, Math.min(box.height, event.clientY - box.y)) *
          (current?.height ?? 1)) /
          box.height,
    }
  }
  const addLayer = (kind: Tool, rect?: Rect) => {
    if (!editable || !current) return
    const box = rect ?? {
      x: Math.round(current.sourceWidth * 0.1),
      y: Math.round(current.sourceHeight * 0.1),
      width: Math.max(1, Math.round(current.sourceWidth * 0.2)),
      height: Math.max(1, Math.round(current.sourceHeight * 0.1)),
    }
    let layer = ''
    edit((s) => {
      if (kind === 'blur') {
        layer = `redaction-${s.redactions.length}`
        s.redactions.push({
          kind: 'field',
          source: 'manual',
          status: 'applied',
          rect: box,
        })
      } else if (kind === 'crop') {
        s.edits = { ...s.edits, crop: box }
        layer = 'crop'
      } else if (kind === 'select') {
        s.click = { x: box.x, y: box.y, radius: s.click?.radius ?? 18 }
        layer = 'click'
      } else {
        const annotations = [...(s.edits?.annotations ?? [])]
        layer = `annotation-${annotations.length}`
        const annotation: Annotation = {
          type: kind,
          x: box.x,
          y: box.y,
          color: 'accent',
          ...(kind === 'rectangle'
            ? { width: box.width, height: box.height }
            : kind === 'arrow'
              ? { toX: box.x + box.width, toY: box.y + box.height }
              : kind === 'text'
                ? { text: 'Annotation' }
                : {
                    text: String(
                      annotations.filter((item) => item.type === 'pin').length +
                        1,
                    ),
                  }),
        }
        annotations.push(annotation)
        s.edits = { ...s.edits, annotations }
      }
    })
    route({ layer })
  }
  const layers: {
    id: string
    label: string
    icon: 'target-small' | 'rectangle-small' | 'blur-small'
    summary: string
  }[] = []
  if (step.click)
    layers.push({
      id: 'click',
      label: 'Click marker',
      icon: 'target-small',
      summary: `x ${step.click.x ?? 0}  y ${step.click.y ?? 0}  r ${step.click.radius}`,
    })
  if (crop)
    layers.push({
      id: 'crop',
      label: 'Crop',
      icon: 'rectangle-small',
      summary: `x ${crop.x}  y ${crop.y}  w ${crop.width}  h ${crop.height}`,
    })
  for (const [index, annotation] of (step.edits?.annotations ?? []).entries())
    layers.push({
      id: `annotation-${index}`,
      label: `${annotation.type}${annotation.text ? ` · ${annotation.text}` : ''}`,
      icon: 'rectangle-small',
      summary: `x ${annotation.x}  y ${annotation.y}${annotation.width !== undefined ? `  w ${annotation.width}  h ${annotation.height}` : ''}`,
    })
  for (const [index, redaction] of step.redactions.entries())
    layers.push({
      id: `redaction-${index}`,
      label: `Blur · ${redaction.kind}`,
      icon: 'blur-small',
      summary: `${redaction.source} · ${redaction.status}`,
    })
  const layerIndex = Number(selected.split('-')[1])
  const activeLayer =
    selected === 'click'
      ? step.click
      : selected === 'crop'
        ? crop
        : selected.startsWith('annotation-')
          ? step.edits?.annotations?.[layerIndex]
          : selected.startsWith('redaction-')
            ? step.redactions[layerIndex]?.rect
            : null
  const changeLayer = (property: string, value: number | string) =>
    edit((s) => {
      const item =
        selected === 'click'
          ? s.click
          : selected === 'crop'
            ? s.edits?.crop
            : selected.startsWith('annotation-')
              ? s.edits?.annotations?.[layerIndex]
              : s.redactions[layerIndex]?.rect
      if (item) Object.assign(item, { [property]: value })
    })
  return (
    <section className="editor-canvas" aria-label="Selected step">
      <div
        className="annotation-toolbar"
        role="toolbar"
        aria-label="Image annotation tools"
      >
        {tools.map((item) => (
          <IconButton
            key={item.name}
            icon={item.icon}
            aria-label={item.label}
            aria-pressed={tool === item.name}
            kind={tool === item.name ? 'secondary' : 'ghost'}
            data-sd={`canvas-tool-${item.name}`}
            disabled={!editable}
            onClick={() =>
              route({ tool: item.name === 'select' ? null : item.name })
            }
          />
        ))}
        <span className="toolbar-divider" />
        <IconButton
          icon="undo"
          data-sd="editor-undo"
          aria-label="Undo edit"
          disabled={!controller.snapshot().canUndo}
          onClick={() => controller.undo()}
        />
        <IconButton
          icon="redo"
          data-sd="editor-redo"
          aria-label="Redo edit"
          disabled={!controller.snapshot().canRedo}
          onClick={() => controller.redo()}
        />
        <span className="toolbar-divider" />
        <select
          aria-label="Image zoom"
          data-sd="canvas-zoom"
          value={actualZoom ?? 'fit'}
          onChange={(event) =>
            route({
              zoom: event.target.value === 'fit' ? null : event.target.value,
            })
          }
        >
          <option value="fit">Fit</option>
          {[25, 50, 75, 100, 150, 200].map((value) => (
            <option key={value} value={value}>
              {value}%
            </option>
          ))}
        </select>
      </div>
      <div
        className="editor-image-scroll"
        tabIndex={0}
        aria-label="Screenshot viewport"
      >
        <div
          ref={frame}
          className={`editor-image ${tool !== 'select' ? 'draw-mode' : ''}`}
          style={
            current
              ? {
                  width: actualZoom
                    ? (current.width * actualZoom) / 100
                    : undefined,
                  aspectRatio: `${current.width}/${current.height}`,
                }
              : undefined
          }
          data-sd="canvas-image"
          aria-busy={!!source && !current && !failed}
          onPointerDown={(event) => {
            if (!editable || !current || event.button !== 0) return
            const p = point(event)
            event.currentTarget.setPointerCapture(event.pointerId)
            setGesture({ ...p, toX: p.x, toY: p.y })
          }}
          onPointerMove={(event) => {
            if (gesture) {
              const p = point(event)
              setGesture({ ...gesture, toX: p.x, toY: p.y })
            }
          }}
          onPointerUp={(event) => {
            if (!gesture || !current) return
            const p = point(event)
            const width = Math.abs(p.x - gesture.x),
              height = Math.abs(p.y - gesture.y)
            setGesture(null)
            if (tool === 'select') {
              const selected = layerAtPoint(step, gesture.x, gesture.y)
              route({ layer: selected })
              if (selected && width + height >= 3)
                edit((s) =>
                  translateLayer(
                    s,
                    selected,
                    Math.round(p.x - gesture.x),
                    Math.round(p.y - gesture.y),
                  ),
                )
              return
            }
            if (
              ['text', 'pin', 'select'].includes(tool) ||
              (width >= 2 && height >= 2)
            )
              addLayer(tool, {
                x: Math.round(
                  tool === 'arrow' ? gesture.x : Math.min(gesture.x, p.x),
                ),
                y: Math.round(
                  tool === 'arrow' ? gesture.y : Math.min(gesture.y, p.y),
                ),
                width:
                  tool === 'arrow'
                    ? Math.round(p.x - gesture.x)
                    : Math.max(1, Math.round(width)),
                height:
                  tool === 'arrow'
                    ? Math.round(p.y - gesture.y)
                    : Math.max(1, Math.round(height)),
              })
          }}
          onPointerCancel={() => setGesture(null)}
        >
          {current ? (
            <>
              <img
                src={current.url}
                alt={step.screenshot?.alt || `Screenshot for ${step.title}`}
                draggable={false}
              />
              {editable &&
              step.click &&
              step.click.x !== undefined &&
              step.click.y !== undefined ? (
                <span
                  className="editor-click-overlay"
                  style={{
                    left: `${((step.click.x - origin.x) / current.width) * 100}%`,
                    top: `${((step.click.y - origin.y) / current.height) * 100}%`,
                  }}
                >
                  <ClickMarker />
                </span>
              ) : null}
              {gesture ? (
                <span
                  className="gesture-box"
                  style={{
                    left: `${((Math.min(gesture.x, gesture.toX) - origin.x) / current.width) * 100}%`,
                    top: `${((Math.min(gesture.y, gesture.toY) - origin.y) / current.height) * 100}%`,
                    width: `${(Math.abs(gesture.toX - gesture.x) / current.width) * 100}%`,
                    height: `${(Math.abs(gesture.toY - gesture.y) / current.height) * 100}%`,
                  }}
                />
              ) : null}
            </>
          ) : (
            <div className="image-placeholder">
              <Icon name="book" />
              <p>
                {!source
                  ? 'Add a screenshot to illustrate this step.'
                  : failed
                    ? 'Image unavailable on this device.'
                    : 'Preparing screenshot…'}
              </p>
              <Button
                kind="secondary"
                size="s"
                data-sd="step-image-upload-empty"
                onClick={upload}
              >
                {source ? 'Replace image' : 'Upload image'}
              </Button>
            </div>
          )}
        </div>
      </div>
      <div className="editor-step-copy">
        <div className="editor-step-title">
          <StepPin>{step.index}</StepPin>
          <TextField
            key={`title-${step.id}`}
            label="Step title"
            hook="step-title"
            className="step-title-field"
            value={step.title}
            required
            maxLength={1000}
            onChange={(value) =>
              edit((s) => {
                s.title = value
              })
            }
          />
          {guide.verification?.status === 'passed' ? (
            <Badge tone="agent">Replay passed</Badge>
          ) : null}
        </div>
        <TextField
          key={`description-${step.id}`}
          label="Step description"
          hook="step-description"
          className="step-description-field"
          value={step.description}
          multiline
          onChange={(value) =>
            edit((s) => {
              s.description = value
            })
          }
        />
        <div className="step-context">
          <Badge dot={false}>
            {step.action ?? step.type}
            {step.target?.role ? ` · ${step.target.role}` : ''}
          </Badge>
          <span>
            {step.url
              ? step.url.replace(/^https?:\/\//, '')
              : 'Manual instruction'}
          </span>
        </div>
      </div>
      <section className="layers-panel" aria-labelledby="layers-heading">
        <div className="layers-heading">
          <h2 id="layers-heading">Layers</h2>
          <span>Select a layer to edit its numbers</span>
        </div>
        <div
          role="listbox"
          aria-label="Image layers"
          className="layer-list"
          onKeyDown={(event) => {
            const index = layers.findIndex((item) => item.id === selected)
            if (
              event.altKey &&
              ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                event.key,
              ) &&
              activeLayer
            ) {
              event.preventDefault()
              const property = ['ArrowLeft', 'ArrowRight'].includes(event.key)
                ? 'x'
                : 'y'
              changeLayer(
                property,
                Math.max(
                  0,
                  (activeLayer[property] ?? 0) +
                    (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1),
                ),
              )
              return
            }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? layers.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          layers.length - 1,
                          index + (event.key === 'ArrowDown' ? 1 : -1),
                        ),
                      )
              const layer = layers[next]
              if (layer) {
                route({ layer: layer.id })
                event.currentTarget
                  .querySelectorAll<HTMLButtonElement>('[role=option]')
                  [next]?.focus()
              }
            }
          }}
        >
          {layers.map((layer, index) => (
            <button
              key={layer.id}
              type="button"
              role="option"
              aria-selected={selected === layer.id}
              tabIndex={
                selected === layer.id || (!selected && index === 0) ? 0 : -1
              }
              data-sd="canvas-layer-select"
              className="layer-row"
              onClick={() => route({ layer: layer.id })}
            >
              <Icon name={layer.icon} />
              <span>{layer.label}</span>
              <code>{layer.summary}</code>
              <Icon name="eye" />
            </button>
          ))}
        </div>
        {!layers.length ? <p className="field-help">No layers yet.</p> : null}
        {editable ? (
          <div className="layer-add-actions">
            <Button
              size="s"
              kind="ghost"
              data-sd="canvas-add-selected-tool"
              onClick={() => addLayer(tool)}
            >
              {tool === 'select' ? 'Add click marker' : `Add ${tool} layer`}
            </Button>
            <Button
              size="s"
              kind="ghost"
              data-sd="canvas-replace-image"
              onClick={upload}
            >
              Replace image
            </Button>
          </div>
        ) : source ? (
          <p className="field-help">
            The redacted source is missing. Replace this screenshot to edit its
            layers.
          </p>
        ) : null}
        {activeLayer ? (
          <fieldset className="layer-numbers" disabled={!editable}>
            <legend>
              {layers.find((layer) => layer.id === selected)?.label}
            </legend>
            {[
              'x',
              'y',
              ...(selected === 'click'
                ? ['radius']
                : selected.startsWith('annotation-') &&
                    'type' in activeLayer &&
                    activeLayer.type === 'arrow'
                  ? ['toX', 'toY']
                  : selected.startsWith('annotation-') &&
                      'type' in activeLayer &&
                      ['text', 'pin'].includes(activeLayer.type)
                    ? []
                    : ['width', 'height']),
            ].map((property) => (
              <label key={property}>
                {property}
                <input
                  type="number"
                  data-sd={`canvas-layer-${property.toLowerCase()}`}
                  aria-label={`Layer ${property}`}
                  min={['radius', 'width', 'height'].includes(property) ? 1 : 0}
                  max={32768}
                  step={1}
                  value={String(Reflect.get(activeLayer, property) ?? 0)}
                  onChange={(event) => {
                    const value = event.currentTarget.valueAsNumber
                    if (
                      Number.isFinite(value) &&
                      value >=
                        (['radius', 'width', 'height'].includes(property)
                          ? 1
                          : 0) &&
                      value <= 32768
                    )
                      changeLayer(property, value)
                  }}
                />
              </label>
            ))}
            {'type' in activeLayer &&
            ['text', 'pin'].includes(activeLayer.type) ? (
              <TextField
                label="Annotation text"
                hook="canvas-layer-text"
                value={activeLayer.text ?? ''}
                required
                onChange={(value) => changeLayer('text', value)}
              />
            ) : null}
            <Button
              kind="danger"
              size="s"
              data-sd="canvas-layer-delete"
              onClick={() => {
                edit((s) => {
                  if (selected === 'click') s.click = null
                  else if (selected === 'crop')
                    s.edits = { ...s.edits, crop: null }
                  else if (selected.startsWith('annotation-'))
                    s.edits = {
                      ...s.edits,
                      annotations: s.edits?.annotations?.filter(
                        (_, index) => index !== layerIndex,
                      ),
                    }
                  else
                    s.redactions = s.redactions.filter(
                      (_, index) => index !== layerIndex,
                    )
                })
                route({ layer: null })
              }}
            >
              Remove layer
            </Button>
          </fieldset>
        ) : null}
      </section>
    </section>
  )
}
