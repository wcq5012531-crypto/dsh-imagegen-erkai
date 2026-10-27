/**
 * Unified image editor: sketch (blank/draw) + annotate (plan marks + box cards).
 *
 * Opens as a modal over the canvas. Apply writes sketch strokes and/or an
 * imagePlan back to the node; box-annotate still creates prompt cards via the
 * host callback so the existing generation path keeps working.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Eraser, Pencil, SquareDashedMousePointer, X } from 'lucide-react'
import { onTablistKeyDown, tabIndexFor } from './tablist.ts'
import type {
  CanvasAnnotation,
  CanvasAssetRef,
  CanvasImagePlan,
  CanvasImagePlanKind,
  CanvasImagePlanMark,
  CanvasNode,
  CanvasRect,
  CanvasSketchStroke,
} from '../protocol.ts'
import type { ImageGenApi } from './api.ts'
import { tt } from './helpers.ts'
import {
  drawImagePlan,
  emptyImagePlan,
  IMAGE_EDIT_COLORS,
  imagePlanOf,
  nextPlanMarkId,
} from './image-edit-plan.ts'
import css from './image-edit-surface.module.css'

const SKETCH_COLORS = ['#1f2328', '#e03131', '#1971c2', '#2f9e44', '#f59f00', '#9c36b5', '#0ca678', '#f06595']
const SKETCH_WIDTHS = [3, 6, 12]
const EXPORT_WIDTH = 1024

export type ImageEditMode = 'sketch' | 'annotate'
export type AnnotateTool = 'box' | CanvasImagePlanKind

export interface ImageEditApplyPayload {
  strokes: CanvasSketchStroke[]
  plan: CanvasImagePlan
  /** New annotation boxes that need prompt cards (normalized rects). */
  newBoxes: CanvasRect[]
  /** Rasterized sketch asset when strokes are non-empty (sketch mode). */
  asset?: CanvasAssetRef
}

function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: CanvasSketchStroke,
  width: number,
  height: number,
): void {
  if (stroke.points.length === 0) return
  ctx.save()
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  const first = stroke.points[0]!
  ctx.moveTo(first.x * width, first.y * height)
  for (const point of stroke.points.slice(1)) ctx.lineTo(point.x * width, point.y * height)
  ctx.stroke()
  ctx.restore()
}

function rasterize(
  strokes: CanvasSketchStroke[],
  boardWidth: number,
  boardHeight: number,
  backgroundUrl?: string,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const scale = EXPORT_WIDTH / Math.max(1, boardWidth)
  const width = EXPORT_WIDTH
  const height = Math.max(1, Math.round(boardHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) return Promise.reject(new Error('no 2d'))
  const paint = (): { dataUrl: string; width: number; height: number } => {
    for (const stroke of strokes) drawStroke(ctx, stroke, width, height)
    return { dataUrl: canvas.toDataURL('image/png'), width, height }
  }
  if (backgroundUrl === undefined || backgroundUrl === '') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    return Promise.resolve(paint())
  }
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(image, 0, 0, width, height)
      resolve(paint())
    }
    image.onerror = () => reject(new Error('background load failed'))
    image.crossOrigin = 'anonymous'
    image.src = backgroundUrl
  })
}

export function ImageEditSurface(props: {
  api: ImageGenApi
  node: CanvasNode
  /** Preferred starting tab. */
  initialMode?: ImageEditMode
  onClose: () => void
  onApply: (payload: ImageEditApplyPayload) => void | Promise<void>
}): React.JSX.Element {
  const assetUrl = props.node.metadata?.asset?.url ?? ''
  const isBlankSketch = (props.node.metadata?.sketch !== undefined) && assetUrl === ''
  const [mode, setMode] = useState<ImageEditMode>(
    props.initialMode ?? (isBlankSketch || props.node.metadata?.sketch !== undefined ? 'sketch' : 'annotate'),
  )
  const [strokes, setStrokes] = useState<CanvasSketchStroke[]>(props.node.metadata?.sketch?.strokes ?? [])
  const [plan, setPlan] = useState<CanvasImagePlan>(imagePlanOf(props.node))
  const [newBoxes, setNewBoxes] = useState<CanvasRect[]>([])
  const [color, setColor] = useState(SKETCH_COLORS[0]!)
  const [planColor, setPlanColor] = useState<string>(IMAGE_EDIT_COLORS[0]!)
  const [widthIndex, setWidthIndex] = useState(1)
  const [erasing, setErasing] = useState(false)
  const [annotateTool, setAnnotateTool] = useState<AnnotateTool>('box')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const liveStrokeRef = useRef<CanvasSketchStroke | null>(null)
  const liveMarkRef = useRef<CanvasImagePlanMark | null>(null)
  const draftBoxRef = useRef<CanvasRect | null>(null)
  const drawingRef = useRef(false)
  const bgRef = useRef<HTMLImageElement | null>(null)

  const redraw = useCallback((): void => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width < 2 || height < 2) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    const bg = bgRef.current
    if (bg !== null && bg.complete && bg.naturalWidth > 0) {
      ctx.drawImage(bg, 0, 0, width, height)
    }
    for (const stroke of strokes) drawStroke(ctx, stroke, width, height)
    const live = liveStrokeRef.current
    if (live !== null) drawStroke(ctx, live, width, height)
    drawImagePlan(ctx, plan, width, height)
    const liveMark = liveMarkRef.current
    if (liveMark !== null) drawImagePlan(ctx, { marks: [liveMark] }, width, height)
    const draft = draftBoxRef.current
    if (draft !== null) {
      ctx.save()
      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth = 2
      ctx.setLineDash([6, 4])
      ctx.strokeRect(draft.x * width, draft.y * height, draft.width * width, draft.height * height)
      ctx.restore()
    }
    // Existing annotation boxes from the node (read-only overlay).
    for (const box of (props.node.metadata?.annotations ?? []) as CanvasAnnotation[]) {
      ctx.save()
      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth = 2
      ctx.strokeRect(box.x * width, box.y * height, box.width * width, box.height * height)
      ctx.restore()
    }
    for (const box of newBoxes) {
      ctx.save()
      ctx.strokeStyle = '#ef4444'
      ctx.lineWidth = 2
      ctx.strokeRect(box.x * width, box.y * height, box.width * width, box.height * height)
      ctx.restore()
    }
  }, [newBoxes, plan, props.node.metadata?.annotations, strokes])

  useEffect(() => {
    if (assetUrl === '') {
      bgRef.current = null
      redraw()
      return
    }
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      bgRef.current = image
      redraw()
    }
    image.onerror = () => {
      bgRef.current = null
      redraw()
    }
    image.src = assetUrl
  }, [assetUrl, redraw])

  useEffect(() => { redraw() }, [redraw])

  const boardPoint = (event: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    if (canvas === null) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const point = boardPoint(event)
    if (point === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    if (mode === 'sketch') {
      if (erasing) {
        const radius = 0.02
        setStrokes(previous => previous.filter(stroke =>
          !stroke.points.some(candidate =>
            Math.abs(candidate.x - point.x) < radius && Math.abs(candidate.y - point.y) < radius)))
        return
      }
      liveStrokeRef.current = { color, width: SKETCH_WIDTHS[widthIndex]!, points: [point] }
      redraw()
      return
    }
    if (annotateTool === 'box') {
      draftBoxRef.current = { x: point.x, y: point.y, width: 0, height: 0 }
      redraw()
      return
    }
    if (annotateTool === 'pin') {
      const mark: CanvasImagePlanMark = {
        id: nextPlanMarkId(plan.marks),
        kind: 'pin',
        points: [point],
        color: planColor,
        width: 2,
        label: String(plan.marks.filter(item => item.kind === 'pin').length + 1),
      }
      setPlan(previous => ({ marks: [...previous.marks, mark] }))
      drawingRef.current = false
      return
    }
    liveMarkRef.current = {
      id: nextPlanMarkId(plan.marks),
      kind: annotateTool,
      points: [point, point],
      color: planColor,
      width: SKETCH_WIDTHS[widthIndex]!,
    }
    redraw()
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current) return
    const point = boardPoint(event)
    if (point === null) return
    if (mode === 'sketch') {
      if (erasing) {
        const radius = 0.02
        setStrokes(previous => previous.filter(stroke =>
          !stroke.points.some(candidate =>
            Math.abs(candidate.x - point.x) < radius && Math.abs(candidate.y - point.y) < radius)))
        return
      }
      const live = liveStrokeRef.current
      if (live === null) return
      live.points.push({ x: Math.round(point.x * 10000) / 10000, y: Math.round(point.y * 10000) / 10000 })
      redraw()
      return
    }
    if (annotateTool === 'box') {
      const draft = draftBoxRef.current
      if (draft === null) return
      const x = Math.min(draft.x, point.x)
      const y = Math.min(draft.y, point.y)
      draftBoxRef.current = {
        x,
        y,
        width: Math.abs(point.x - draft.x),
        height: Math.abs(point.y - draft.y),
      }
      // Keep origin as first corner for min math — store absolute box.
      const originX = (draft as CanvasRect & { _ox?: number })._ox ?? draft.x
      const originY = (draft as CanvasRect & { _oy?: number })._oy ?? draft.y
      draftBoxRef.current = {
        x: Math.min(originX, point.x),
        y: Math.min(originY, point.y),
        width: Math.abs(point.x - originX),
        height: Math.abs(point.y - originY),
      }
      ;(draftBoxRef.current as CanvasRect & { _ox?: number; _oy?: number })._ox = originX
      ;(draftBoxRef.current as CanvasRect & { _oy?: number })._oy = originY
      redraw()
      return
    }
    const live = liveMarkRef.current
    if (live === null) return
    if (live.kind === 'pen' || live.kind === 'freecircle' || live.kind === 'arrow') {
      live.points.push(point)
    } else {
      live.points = [live.points[0]!, point]
    }
    redraw()
  }

  const onPointerUp = (): void => {
    if (!drawingRef.current) return
    drawingRef.current = false
    if (mode === 'sketch') {
      const live = liveStrokeRef.current
      liveStrokeRef.current = null
      if (live !== null && live.points.length > 0) setStrokes(previous => [...previous, live])
      redraw()
      return
    }
    if (annotateTool === 'box') {
      const draft = draftBoxRef.current
      draftBoxRef.current = null
      if (draft !== null && draft.width > 0.01 && draft.height > 0.01) {
        setNewBoxes(previous => [...previous, {
          x: draft.x, y: draft.y, width: draft.width, height: draft.height,
        }])
      }
      redraw()
      return
    }
    const live = liveMarkRef.current
    liveMarkRef.current = null
    if (live !== null && live.points.length >= 1) {
      setPlan(previous => ({ marks: [...previous.marks, live] }))
    }
    redraw()
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      let asset: CanvasAssetRef | undefined
      if (strokes.length > 0) {
        const canvas = canvasRef.current
        const boardWidth = canvas?.clientWidth ?? 512
        const boardHeight = canvas?.clientHeight ?? 512
        const raster = await rasterize(strokes, boardWidth, boardHeight, assetUrl || undefined)
        asset = await props.api.canvasUpload(raster.dataUrl, raster.width, raster.height, {
          origin: 'upload',
          originId: `edit-${props.node.id}`,
        })
      }
      await props.onApply({
        strokes,
        plan: plan.marks.length === 0 ? emptyImagePlan() : plan,
        newBoxes,
        asset,
      })
      props.onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return <div className={css.root} data-image-edit-surface="" role="dialog" aria-modal="true" aria-label={tt('canvas.editImage')}>
    <div className={css.panel}>
      <header className={css.header}>
        <strong>{tt('canvas.editImage')}</strong>
        <span className={css.subtitle}>{props.node.title}</span>
        <span className={css.spacer} />
        <div className={css.tabs} role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'sketch'} data-active={mode === 'sketch' ? '' : undefined} tabIndex={tabIndexFor(mode === 'sketch')} onKeyDown={event => { onTablistKeyDown(event, { count: 2, index: 0, select: next => setMode(next === 0 ? 'sketch' : 'annotate') }) }} onClick={() => setMode('sketch')}>{tt('canvas.edit.modeSketch')}</button>
          <button type="button" role="tab" aria-selected={mode === 'annotate'} data-active={mode === 'annotate' ? '' : undefined} tabIndex={tabIndexFor(mode === 'annotate')} onKeyDown={event => { onTablistKeyDown(event, { count: 2, index: 1, select: next => setMode(next === 0 ? 'sketch' : 'annotate') }) }} onClick={() => setMode('annotate')}>{tt('canvas.edit.modeAnnotate')}</button>
        </div>
        <button type="button" className={css.iconButton} aria-label={tt('canvas.edit.close')} onClick={props.onClose}><X size={16} /></button>
      </header>
      <p className={css.hint}>{tt(mode === 'sketch' ? 'canvas.edit.hintSketch' : 'canvas.edit.hintAnnotate')}</p>
      <div className={css.toolbar}>
        {mode === 'sketch' ? <>
          <button type="button" data-active={!erasing ? '' : undefined} onClick={() => setErasing(false)} title={tt('canvas.edit.toolBrush')}><Pencil size={14} /></button>
          <button type="button" data-active={erasing ? '' : undefined} onClick={() => setErasing(true)} title={tt('canvas.edit.toolEraser')}><Eraser size={14} /></button>
          <span className={css.divider} />
          {SKETCH_COLORS.map(item => <button key={item} type="button" className={css.swatch} style={{ background: item }} data-active={item === color && !erasing ? '' : undefined} onClick={() => { setColor(item); setErasing(false) }} aria-label={item} />)}
          <span className={css.divider} />
          {SKETCH_WIDTHS.map((item, index) => <button key={item} type="button" data-active={widthIndex === index ? '' : undefined} onClick={() => setWidthIndex(index)}>{item}px</button>)}
          <button type="button" onClick={() => setStrokes(previous => previous.slice(0, -1))}>{tt('canvas.sketchUndo')}</button>
          <button type="button" onClick={() => setStrokes([])}>{tt('canvas.edit.clear')}</button>
        </> : <>
          <button type="button" data-active={annotateTool === 'box' ? '' : undefined} onClick={() => setAnnotateTool('box')} title={tt('canvas.edit.toolBox')}><SquareDashedMousePointer size={14} /></button>
          <button type="button" data-active={annotateTool === 'pin' ? '' : undefined} onClick={() => setAnnotateTool('pin')}>{tt('canvas.edit.toolPin')}</button>
          <button type="button" data-active={annotateTool === 'arrow' ? '' : undefined} onClick={() => setAnnotateTool('arrow')}>{tt('canvas.edit.toolArrow')}</button>
          <button type="button" data-active={annotateTool === 'ellipse' ? '' : undefined} onClick={() => setAnnotateTool('ellipse')}>{tt('canvas.edit.toolEllipse')}</button>
          <button type="button" data-active={annotateTool === 'freecircle' ? '' : undefined} onClick={() => setAnnotateTool('freecircle')}>{tt('canvas.edit.toolFree')}</button>
          <button type="button" data-active={annotateTool === 'pen' ? '' : undefined} onClick={() => setAnnotateTool('pen')}><Pencil size={14} /></button>
          <span className={css.divider} />
          {IMAGE_EDIT_COLORS.map(item => <button key={item} type="button" className={css.swatch} style={{ background: item }} data-active={item === planColor ? '' : undefined} onClick={() => setPlanColor(item)} aria-label={item} />)}
          <button type="button" onClick={() => { setPlan(emptyImagePlan()); setNewBoxes([]) }}>{tt('canvas.edit.clear')}</button>
        </>}
      </div>
      <div className={css.stage}>
        <canvas
          ref={canvasRef}
          className={css.board}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
      {error !== null ? <p className={css.error}>{error}</p> : null}
      <footer className={css.footer}>
        <button type="button" className={css.ghost} onClick={props.onClose} disabled={busy}>{tt('canvas.edit.close')}</button>
        <button type="button" className={css.primary} onClick={() => { void apply() }} disabled={busy}>{tt('canvas.edit.apply')}</button>
      </footer>
    </div>
  </div>
}
