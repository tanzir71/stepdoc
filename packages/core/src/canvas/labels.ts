import type { Annotation } from '@stepdoc/schema'
import tokens from '../../../../docs/v2/design-tokens.json'
import { CANVAS_LIMITS } from './geometry'

/** Image-pixel layout for a rectangle's optional caption. Text width is measured by the caller. */
export function rectangleLabelLayout(
  annotation: Pick<Annotation, 'x' | 'y' | 'height' | 'toX' | 'toY'>,
) {
  const style = tokens.type['label-s']
  const scale = Math.min(
    CANVAS_LIMITS.maxLabelFontSize / style.size,
    Math.max(0, annotation.height ?? 0) / tokens.space['8'],
  )
  return {
    x: annotation.toX ?? annotation.x,
    y:
      annotation.toY ??
      annotation.y + (annotation.height ?? 0) + tokens.space['2.5'] * scale,
    height: (style.line + tokens.space['1'] * 2) * scale,
    padding: tokens.space['2'] * scale,
    radius: tokens.radius.sm * scale,
    outlineRadius: tokens.radius.md * scale,
    fontSize: style.size * scale,
    fontWeight: style.weight,
  }
}
