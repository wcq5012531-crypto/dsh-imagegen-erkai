/**
 * Pure helpers for the unified image-edit plan (annotate overlays).
 *
 * Kept out of CanvasWorkspace so prompt export and overlay drawing stay
 * testable without mounting the whole canvas.
 */

import type { CanvasImagePlan, CanvasImagePlanMark, CanvasNode } from '../protocol.ts'

export const IMAGE_EDIT_COLORS = ['#ef4444', '#1f2328', '#1971c2', '#2f9e44', '#f59f00', '#9c36b5'] as const

export function emptyImagePlan(): CanvasImagePlan {
  return { marks: [] }
}

export function imagePlanOf(node: CanvasNode): CanvasImagePlan {
  const stored = node.metadata?.imagePlan
  if (stored === undefined || !Array.isArray(stored.marks)) return emptyImagePlan()
  return { marks: stored.marks.filter(mark => typeof mark?.id === 'string' && Array.isArray(mark.points)) }
}

export function nextPlanMarkId(marks: readonly CanvasImagePlanMark[]): string {
  const used = new Set(marks.map(mark => mark.id))
  for (let index = 1; index < 10_000; index += 1) {
    const id = `mark-${index}`
    if (!used.has(id)) return id
  }
  return `mark-${Date.now().toString(36)}`
}

/** Fold plan marks into prompt lines the generation path can append. */
export function imagePlanPromptLines(plan: CanvasImagePlan): string[] {
  const lines: string[] = []
  let pin = 0
  for (const mark of plan.marks) {
    const note = (mark.note ?? mark.label ?? '').trim()
    if (mark.kind === 'pin') {
      pin += 1
      const label = note === '' ? String(pin) : note
      lines.push(`标注针脚 ${label}：请关注该位置。`)
      continue
    }
    if (note === '') continue
    const kindLabel =
      mark.kind === 'arrow' ? '箭头区域'
        : mark.kind === 'ellipse' ? '椭圆区域'
          : mark.kind === 'freecircle' ? '圈选区域'
            : mark.kind === 'pen' ? '笔触区域'
              : mark.kind === 'text' ? '文字标注'
                : '框选区域'
    lines.push(`${kindLabel}：${note}`)
  }
  return lines
}

/** Draw plan marks onto a 2D context whose size matches the image display box. */
export function drawImagePlan(
  ctx: CanvasRenderingContext2D,
  plan: CanvasImagePlan,
  width: number,
  height: number,
): void {
  let pin = 0
  for (const mark of plan.marks) {
    ctx.save()
    ctx.strokeStyle = mark.color
    ctx.fillStyle = mark.color
    ctx.lineWidth = Math.max(1, mark.width)
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    const pts = mark.points.map(point => ({
      x: point.x * width,
      y: point.y * height,
    }))
    if (mark.kind === 'rect' && pts.length >= 2) {
      const a = pts[0]!
      const b = pts[1]!
      const x = Math.min(a.x, b.x)
      const y = Math.min(a.y, b.y)
      const w = Math.abs(b.x - a.x)
      const h = Math.abs(b.y - a.y)
      ctx.strokeRect(x, y, w, h)
    } else if (mark.kind === 'ellipse' && pts.length >= 2) {
      const a = pts[0]!
      const b = pts[1]!
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      const rx = Math.abs(b.x - a.x) / 2
      const ry = Math.abs(b.y - a.y) / 2
      ctx.beginPath()
      ctx.ellipse(cx, cy, Math.max(1, rx), Math.max(1, ry), 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (mark.kind === 'arrow' && pts.length >= 2) {
      const from = pts[0]!
      const to = pts[pts.length - 1]!
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      for (const point of pts.slice(1)) ctx.lineTo(point.x, point.y)
      ctx.stroke()
      const angle = Math.atan2(to.y - from.y, to.x - from.x)
      const head = 10 + mark.width
      ctx.beginPath()
      ctx.moveTo(to.x, to.y)
      ctx.lineTo(to.x - head * Math.cos(angle - 0.4), to.y - head * Math.sin(angle - 0.4))
      ctx.lineTo(to.x - head * Math.cos(angle + 0.4), to.y - head * Math.sin(angle + 0.4))
      ctx.closePath()
      ctx.fill()
    } else if ((mark.kind === 'freecircle' || mark.kind === 'pen') && pts.length >= 2) {
      ctx.beginPath()
      ctx.moveTo(pts[0]!.x, pts[0]!.y)
      for (const point of pts.slice(1)) ctx.lineTo(point.x, point.y)
      if (mark.kind === 'freecircle') ctx.closePath()
      ctx.stroke()
    } else if (mark.kind === 'pin' && pts.length >= 1) {
      pin += 1
      const point = pts[0]!
      const r = 10
      ctx.beginPath()
      ctx.arc(point.x, point.y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#ffffff'
      ctx.font = `bold ${Math.max(10, r)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText((mark.label ?? String(pin)).slice(0, 3), point.x, point.y)
    } else if (mark.kind === 'text' && pts.length >= 1) {
      const point = pts[0]!
      ctx.font = `${12 + mark.width}px sans-serif`
      ctx.fillText((mark.label ?? mark.note ?? '').slice(0, 40), point.x, point.y)
    }
    ctx.restore()
  }
}
