/**
 * Lightweight material hover preview for canvas thumbs.
 *
 * Reuses gallery/history URLs already on the node — does not introduce a second
 * material library. Show on delayed mouseenter; hide on leave / Escape.
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { tt } from './helpers.ts'
import css from './hover-preview.module.css'

export interface HoverPreviewPayload {
  kind: 'image' | 'video'
  url: string
  title?: string
  /** Screen anchor (usually cursor or thumb rect). */
  x: number
  y: number
}

const SHOW_DELAY_MS = 160

export function HoverPreviewHost(props: {
  payload: HoverPreviewPayload | null
}): React.JSX.Element | null {
  const [visible, setVisible] = useState<HoverPreviewPayload | null>(null)

  useEffect(() => {
    if (props.payload === null) {
      setVisible(null)
      return
    }
    const timer = window.setTimeout(() => setVisible(props.payload), SHOW_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [props.payload])

  useEffect(() => {
    if (visible === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setVisible(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible])

  if (visible === null) return null

  const left = Math.min(window.innerWidth - 340, Math.max(8, visible.x + 16))
  const top = Math.min(window.innerHeight - 280, Math.max(8, visible.y + 16))

  return createPortal(
    <div
      className={css.root}
      style={{ left, top }}
      data-hover-preview=""
      role="img"
      aria-label={visible.title ?? tt('canvas.hoverPreview')}
    >
      {visible.kind === 'video'
        ? <video className={css.media} src={visible.url} muted autoPlay loop playsInline />
        : <img className={css.media} src={visible.url} alt="" />}
      {visible.title !== undefined && visible.title !== ''
        ? <span className={css.caption}>{visible.title}</span>
        : null}
    </div>,
    document.body,
  )
}
