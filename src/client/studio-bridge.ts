/**
 * 普通生图 ⇄ 无限画布 的直连通道。
 *
 * 画布里的节点是「素材」，普通生图的输入框要的是「参考素材」。两边本来就共享
 * 同一份 /api/gallery 与 /api/history，缺的只是把画布上当前这一张（可能是刚生成、
 * 还没入库的产物）直接塞进对面输入框的动作。用一个极小的收发队列实现，避免把
 * 两边的工作区状态互相穿透。
 */

export interface StudioInboxItem {
  /** Media URL: /files/... , data: , http(s): . */
  url: string
  name?: string
  kind: 'image' | 'video'
}

let pending: StudioInboxItem[] = []
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // A broken subscriber must not block the rest.
    }
  }
}

/** 画布 → 普通生图：把一张图/一段视频送进输入框。 */
export function sendToStudio(item: StudioInboxItem): void {
  if (item.url.trim() === '') return
  pending = [...pending, item]
  notify()
}

/** 普通生图侧订阅：有新素材进来时被叫一次。返回退订函数。 */
export function subscribeStudioInbox(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 取走全部待处理素材（取走后队列清空）。 */
export function drainStudioInbox(): StudioInboxItem[] {
  if (pending.length === 0) return []
  const taken = pending
  pending = []
  return taken
}
