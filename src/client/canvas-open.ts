/**
 * 「打开某张画布」的跨面板请求。
 *
 * WHY 一个共享小模块，而不是直接派发事件：素材库的历史栏把工作区切成
 * `canvas` 之后立刻派发事件，可 `CanvasWorkspace` 是同一提交里才挂载的，
 * 它的监听还没注册——事件当场丢掉，用户看到的是「点了没反应」。
 * 所以请求同时写进这个插槽：已挂载的由事件处理，未挂载的挂载时取走。
 */
export const CANVAS_OPEN_EVENT = 'dsh-imagegen-studio:open-canvas'

export interface CanvasOpenRequest {
  /** 要打开的画布 id。 */
  canvasId: string
  /** 打开后要选中并居中的节点（从历史/素材库跳回生成它的那个节点）。 */
  nodeId?: string
}

let pending: CanvasOpenRequest | undefined

/** 请求打开一张画布；事件与插槽两条路都发，先到先得。 */
export function requestCanvasOpen(request: CanvasOpenRequest): void {
  pending = request
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<CanvasOpenRequest>(CANVAS_OPEN_EVENT, { detail: request }))
}

/** 取走挂载前就到达的请求（没有则为 undefined），取走后即失效。 */
export function takePendingCanvasOpen(): CanvasOpenRequest | undefined {
  const request = pending
  pending = undefined
  return request
}

/**
 * 声明某个请求已经由事件路径处理掉了。
 *
 * 不这样做的话，插槽里的值会一直留到下一次 `CanvasWorkspace` 挂载——用户离开
 * 画布再回来就会被弹回那张旧画布，像是点击被重放了一次。
 */
export function clearPendingCanvasOpen(canvasId: string): void {
  if (pending?.canvasId === canvasId) pending = undefined
}

/** 某张画布刚被删掉时派发的事件名。 */
export const CANVAS_REMOVED_EVENT = 'dsh-imagegen-studio:canvas-removed'

export interface CanvasRemovedNotice {
  canvasId: string
}

/**
 * 告诉画布「这张文档没了」。
 *
 * WHY 必须有人接着：删除只发生在左栏，画布那一半并不知道。它仍然拿着这张
 * 文档，下一次自动保存就会把刚删掉的文件重新写回来——用户看到的是「删了又
 * 回来」。所以左栏删完要喊一声，画布收到后离开这张文档再去补一次删除。
 */
export function announceCanvasRemoved(canvasId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<CanvasRemovedNotice>(CANVAS_REMOVED_EVENT, { detail: { canvasId } }))
}
