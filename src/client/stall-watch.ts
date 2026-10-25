/**
 * Main-thread stall watchdog.
 *
 * The freeze the user hit left no trace: the renderer stops painting, nothing
 * reaches the host log, and by the time anyone looks the app is responsive
 * again. A setInterval callback cannot run while the thread is blocked, so the
 * delay between two ticks is exactly how long the thread was stuck — measuring
 * that drift and reporting the first stall after recovery turns "it froze once"
 * into a record with the panel, dialog and heap sizes at that moment.
 */

import { STUDIO_API } from '../studio/types.ts'

/** How often the watchdog checks for drift. */
const TICK_MS = 1000
/** A gap this much longer than the tick is a stall worth reporting. */
const STALL_MS = 2500
/** Never report more than once per this window, so a wobbly thread stays readable. */
const REPORT_GAP_MS = 10_000

let installed = false
let previous = 0
let lastReport = 0
/** Last thing the user asked the panel to do; written to the breadcrumb. */
let action = 'idle'

/** Survives a force-kill, so the next boot can say when the renderer died. */
const ALIVE_KEY = 'dsh-imagegen-studio:alive'
/** A gap this long between boots means the previous run was killed while stuck. */
const KILLED_MS = 15_000

/** Record what the panel is doing, for the breadcrumb and the stall report. */
export function noteAction(next: string): void {
  action = next
}

/**
 * A monotonic clock that also exists where `performance` does not (the jsdom
 * smoke fixture, older embedded webviews). Reading a bare `performance` there
 * threw during `installStallWatch`, which aborted the whole panel mount: the
 * watchdog has to degrade to `Date.now()`, never take the studio down with it.
 */
function clock(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance
  return typeof perf?.now === 'function' ? perf.now() : Date.now()
}

/** Write the breadcrumb; a frozen thread simply stops writing it. */
function writeBreadcrumb(): void {
  try {
    const view = document.querySelector('[data-dsh-imagegen-studio-view]')
    const workspace = view?.querySelector('[data-workspace]')?.getAttribute('data-workspace') ?? ''
    window.localStorage.setItem(ALIVE_KEY, JSON.stringify({ t: Date.now(), workspace, action }))
  } catch {
    // A full or blocked storage is not worth breaking the panel over.
  }
}

/** Collect what is cheap to read and still narrows the cause. */
function snapshot(gapMs: number): Record<string, unknown> {
  const memory = (globalThis as {
    performance?: { memory?: { usedJSHeapSize: number, jsHeapSizeLimit: number } }
  }).performance?.memory
  const view = document.querySelector('[data-dsh-imagegen-studio-view]')
  const workspace = view?.querySelector('[data-workspace]')?.getAttribute('data-workspace') ?? ''
  return {
    at: new Date().toISOString(),
    gapMs,
    workspace,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    panels: document.querySelectorAll('[data-dsh-imagegen-studio-view]').length,
    canvases: document.querySelectorAll('canvas').length,
    nodes: document.querySelectorAll('*').length,
    heapUsedMb: memory === undefined ? null : Math.round(memory.usedJSHeapSize / 1_048_576),
    heapLimitMb: memory === undefined ? null : Math.round(memory.jsHeapSizeLimit / 1_048_576),
    // 判据：`hidden: true` 的 60 秒空档是浏览器在节流，不是主线程被卡住。
    // 只有 `hidden: false` 的长空档才是真的冻结。
    visibility: document.visibilityState,
    hidden: document.visibilityState !== 'visible',
    focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
  }
}

/** Start the watchdog once per page. */
export function installStallWatch(): void {
  if (installed) return
  installed = true
  previous = clock()

  // The previous run's last breath: if the app was killed while frozen, this is
  // the only timestamp that survives, and it names the view and the action.
  try {
    const raw = window.localStorage.getItem(ALIVE_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { t?: number, workspace?: string, action?: string }
      const gap = Date.now() - (parsed.t ?? 0)
      if (gap > KILLED_MS) {
        void fetch(STUDIO_API.diag, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: new Date().toISOString(), kind: 'killed-while-busy', gapMs: gap, workspace: parsed.workspace, action: parsed.action }),
        }).catch(() => {})
      }
    }
    window.localStorage.setItem(ALIVE_KEY, JSON.stringify({ t: Date.now(), workspace: '', action: 'boot' }))
  } catch {
    // Diagnostics only.
  }

  // A long task reports the moment it ENDS, so it is the only witness that
  // survives a freeze the thread later recovers from.
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 3000) continue
        void fetch(STUDIO_API.diag, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at: new Date().toISOString(), kind: 'longtask', durationMs: Math.round(entry.duration), name: entry.name, action }),
        }).catch(() => {})
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // Older engines have no longtask entry type.
  }

  window.setInterval(() => {
    writeBreadcrumb()
    const now = clock()
    const gap = now - previous
    previous = now
    if (gap < STALL_MS || now - lastReport < REPORT_GAP_MS) return
    lastReport = now
    void fetch(STUDIO_API.diag, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...snapshot(Math.round(gap)), kind: 'stall', action }),
    }).catch(() => { /* the watchdog must never be the reason something fails */ })
  }, TICK_MS)
}
