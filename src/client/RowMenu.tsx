/**
 * The right-click menu shared by the history rows and the gallery cards.
 *
 * It renders through a portal: a card's `overflow: hidden`, the sidebar's
 * scroll container and the panel's own stacking context would otherwise clip a
 * menu that the user opened on the last row of a scrolled list.
 *
 * The menu owns no product logic. Every item is a label plus one of the
 * handlers the row already calls, so the menu can never drift from the button
 * it mirrors.
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import css from './panel.module.css'

export interface RowMenuItem {
  /** Stable id: the React key and `data-menu-key` (tests click by this). */
  key: string
  label: string
  /** Destructive actions are red — delete, remove from gallery. */
  danger?: boolean
  disabled?: boolean
  run: () => void
}

export interface RowMenuState {
  x: number
  y: number
  items: RowMenuItem[]
}

const MENU_WIDTH = 168
const ITEM_HEIGHT = 30
const VIEWPORT_MARGIN = 8

/**
 * State + open helper for one menu. The position is clamped here, not in the
 * component, so a right click on the last visible row opens upward instead of
 * rendering a menu that the viewport cuts off.
 */
/**
 * Where the menu should appear. A React event is what a handler receives, but
 * the rows open the menu from a plain DOM listener as well (see
 * `ImageGenPanel`'s `contextMenuFor`), so a bare point is accepted too.
 */
export type RowMenuAnchor = ReactMouseEvent | { x: number; y: number }

export function useRowMenu(): [RowMenuState | null, (anchor: RowMenuAnchor, items: RowMenuItem[]) => void, () => void] {
  const [state, setState] = useState<RowMenuState | null>(null)

  const open = useCallback((anchor: RowMenuAnchor, items: RowMenuItem[]) => {
    let x: number
    let y: number
    if ('clientX' in anchor) {
      anchor.preventDefault()
      anchor.stopPropagation()
      x = anchor.clientX
      y = anchor.clientY
    } else {
      x = anchor.x
      y = anchor.y
    }
    const height = items.length * ITEM_HEIGHT + VIEWPORT_MARGIN * 2
    setState({
      x: Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - height)),
      items,
    })
  }, [])

  const close = useCallback(() => { setState(null) }, [])

  return [state, open, close]
}

export function RowMenu({ state, onClose }: { state: RowMenuState | null; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (state === null) return
    const onPointerDown = (event: MouseEvent): void => {
      if (menuRef.current !== null && menuRef.current.contains(event.target as Node)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [state, onClose])

  if (state === null) return null

  return createPortal(
    <div
      ref={menuRef}
      className={css.rowMenu}
      role="menu"
      data-row-menu=""
      style={{ left: state.x, top: state.y }}
    >
      {state.items.map(item => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={css.rowMenuItem}
          data-menu-key={item.key}
          data-danger={item.danger === true ? '' : undefined}
          disabled={item.disabled === true}
          onClick={() => { onClose(); item.run() }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
