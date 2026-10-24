/**
 * In-memory task registry for the studio panel.
 *
 * A video render takes minutes and a continuation chain takes tens of minutes,
 * so the panel cannot hold an HTTP request open for it. Every generation starts
 * here, returns an id, and is polled; the same id is what the Cancel button
 * aborts.
 *
 * Deliberately in-memory: a task is worthless after the host process restarts
 * (its render connection is gone with it) and a persisted task would only
 * resurrect a spinner that can never finish. The *results* are persisted, by the
 * generation code, as files — that is what survives.
 */

import { randomUUID } from 'node:crypto'

/** Lifecycle of one studio task. */
export type StudioTaskState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** One produced asset, already persisted and served. */
export interface StudioAsset {
  url: string
  mime: string
  bytes: number
  /** Measured or requested length, for videos. */
  duration?: number
  revisedPrompt?: string
}

/** What a finished task produced. */
export type StudioTaskResult =
  | { kind: 'image'; images: StudioAsset[] }
  | {
    kind: 'video'
    video: StudioAsset
    /** Per-segment clips of a continuation chain, when they were kept. */
    segments?: StudioAsset[]
    warnings?: string[]
  }

/** A task as the browser sees it. */
export interface StudioTaskView {
  id: string
  kind: 'image' | 'video' | 'continuum'
  state: StudioTaskState
  phase: string
  message: string
  /** 0–100, or undefined when the upstream gives no signal. */
  progress?: number
  createdAt: number
  updatedAt: number
  result?: StudioTaskResult
  error?: { code: string; message: string }
}

/** Internal record. */
interface StudioTaskRecord extends StudioTaskView {
  controller: AbortController
}

/** Task caps: a panel left open for a week must not grow without bound. */
const MAX_TASKS = 96
/** Finished tasks are dropped after this long. */
const TASK_TTL_MS = 30 * 60 * 1000

/** The registry. */
const tasks = new Map<string, StudioTaskRecord>()

/** Drop finished tasks past their TTL, then the oldest overflow. */
function prune(): void {
  const now = Date.now()
  for (const [id, task] of tasks) {
    const finished = task.state === 'done' || task.state === 'error' || task.state === 'cancelled'
    if (finished && now - task.updatedAt > TASK_TTL_MS) tasks.delete(id)
  }
  while (tasks.size > MAX_TASKS) {
    const oldest = [...tasks.values()]
      .filter(task => task.state !== 'running' && task.state !== 'queued')
      .sort((left, right) => left.updatedAt - right.updatedAt)[0]
    if (oldest === undefined) break
    tasks.delete(oldest.id)
  }
}

/**
 * Register a task and hand the caller its id plus the controller to pass down.
 * @param kind - which pipeline this is.
 * @returns the new task id and its abort controller.
 */
export function createStudioTask(kind: StudioTaskView['kind']): { id: string; controller: AbortController } {
  prune()
  const id = randomUUID()
  const now = Date.now()
  const controller = new AbortController()
  tasks.set(id, {
    id,
    kind,
    state: 'queued',
    phase: '排队',
    message: '已受理',
    createdAt: now,
    updatedAt: now,
    controller,
  })
  return { id, controller }
}

/**
 * Advance a task.
 * @param id - task id.
 * @param patch - fields to overwrite.
 */
export function updateStudioTask(
  id: string,
  patch: { state?: StudioTaskState; phase?: string; message?: string; progress?: number; result?: StudioTaskResult; error?: { code: string; message: string } },
): void {
  const task = tasks.get(id)
  if (task === undefined) return
  if (patch.state !== undefined) task.state = patch.state
  if (patch.phase !== undefined) task.phase = patch.phase
  if (patch.message !== undefined) task.message = patch.message
  if (patch.progress !== undefined) task.progress = Math.max(0, Math.min(100, patch.progress))
  if (patch.result !== undefined) task.result = patch.result
  if (patch.error !== undefined) task.error = patch.error
  task.updatedAt = Date.now()
}

/**
 * Read one task for the browser (the abort controller never leaves the host).
 * @param id - task id.
 * @returns the view, or undefined when it never existed / already expired.
 */
export function readStudioTask(id: string): StudioTaskView | undefined {
  const task = tasks.get(id)
  if (task === undefined) return undefined
  const { controller: _controller, ...view } = task
  return view
}

/**
 * Ask a running task to stop.
 * @param id - task id.
 * @returns true when the task was known and still running.
 */
export function cancelStudioTask(id: string): boolean {
  const task = tasks.get(id)
  if (task === undefined) return false
  if (task.state === 'done' || task.state === 'error' || task.state === 'cancelled') return false
  task.controller.abort()
  task.state = 'cancelled'
  task.phase = '已取消'
  task.message = '已取消'
  task.updatedAt = Date.now()
  return true
}

/**
 * Signalled when the task was cancelled between two awaits, so a pipeline can
 * stop at its next checkpoint instead of finishing work nobody wants.
 * @param id - task id.
 */
export function isStudioTaskCancelled(id: string): boolean {
  return tasks.get(id)?.controller.signal.aborted === true
}
