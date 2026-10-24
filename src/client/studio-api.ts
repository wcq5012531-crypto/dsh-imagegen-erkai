/**
 * Browser client for the studio routes.
 *
 * Same envelope convention as the rest of the panel: every response is
 * `{ ok, ... }`, and anything that is not `ok` throws an error carrying the
 * route's own message, so the UI can show the gateway's words instead of a
 * generic failure.
 */

import {
  STUDIO_API,
  type StudioAdaptersResponse,
  type StudioAdoptRequest,
  type StudioContinuumRequest,
  type StudioDiscoverResult,
  type StudioGenerateRequest,
  type StudioPreviewResult,
  type StudioStartResponse,
  type StudioTaskResponse,
} from '../studio/types.ts'

/** Error carrying the route's code and message. */
export class StudioApiError extends Error {
  readonly code: string
  readonly warnings: string[]

  constructor(message: string, code = 'studio-failed', warnings: string[] = []) {
    super(message)
    this.name = 'StudioApiError'
    this.code = code
    this.warnings = warnings
  }
}

/**
 * Parse one envelope, throwing on failure.
 * @param response - the fetch response.
 */
async function envelope<T extends { ok: boolean }>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new StudioApiError(`HTTP ${String(response.status)}：响应不是 JSON`)
  }
  if (body === null || typeof body !== 'object') throw new StudioApiError('响应格式不对')
  const record = body as Record<string, unknown>
  if (record.ok !== true) {
    const message = typeof record.message === 'string' ? record.message : `HTTP ${String(response.status)}`
    const code = typeof record.code === 'string' ? record.code : 'studio-failed'
    const warnings = Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === 'string') : []
    throw new StudioApiError(message, code, warnings)
  }
  return body as T
}

/** POST one JSON body and parse the envelope. */
async function post<T extends { ok: boolean }>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return envelope<T>(response)
}

/** Read the masked adapter list. */
export async function listAdapters(): Promise<StudioAdaptersResponse> {
  return envelope<StudioAdaptersResponse>(await fetch(STUDIO_API.adapters))
}

/** Create or update one adapter. */
export async function saveAdapter(adapter: unknown): Promise<{ ok: true; adapter: unknown; warnings: string[] }> {
  return post(STUDIO_API.adapter, { adapter })
}

/** Delete one adapter. */
export async function deleteAdapter(id: string): Promise<{ ok: true; removed: boolean }> {
  return post(STUDIO_API.adapterDelete, { id })
}

/** Probe a gateway for its model list. */
export async function discoverModels(input: { adapterId?: string; adapter?: unknown; modelsPath?: string }): Promise<StudioDiscoverResult> {
  return post(STUDIO_API.discover, input)
}

/**
 * Adopt discovered models into the channel behind one adapter. The channel's
 * catalogue is the only place the studio reads models from, so this writes the
 * settings document — there is no per-adapter model list to append to.
 */
export async function adoptModels(request: StudioAdoptRequest): Promise<{ ok: true; added: number }> {
  return post(STUDIO_API.adopt, request)
}

/**
 * Render the exact wire request without sending it.
 *
 * Pass `adapter` to preview the draft the editor is holding: the host normalizes
 * it exactly like a save would, and inherits the stored token when the draft
 * carries none, so the body can be inspected before anything is written.
 */
export async function previewRequest(request: StudioGenerateRequest & { adapter?: Record<string, unknown> }): Promise<StudioPreviewResult> {
  return post(STUDIO_API.preview, request)
}

/** Start one chat generation. */
export async function startGenerate(request: StudioGenerateRequest): Promise<StudioStartResponse> {
  return post(STUDIO_API.generate, request)
}

/** Start a tail-frame continuation chain. */
export async function startContinuum(request: StudioContinuumRequest): Promise<StudioStartResponse> {
  return post(STUDIO_API.continuum, request)
}

/** Poll one task. */
export async function readTask(taskId: string): Promise<StudioTaskResponse> {
  return envelope<StudioTaskResponse>(await fetch(`${STUDIO_API.task}/${encodeURIComponent(taskId)}`))
}

/** Cancel one task. */
export async function cancelTask(taskId: string): Promise<{ ok: true; cancelled: boolean }> {
  return post(STUDIO_API.cancel, { taskId })
}

/** Convert a Blob/File to a data URI, for reference materials. */
export function toDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(typeof reader.result === 'string' ? reader.result : '') }
    reader.onerror = () => { reject(new Error(`读取 ${file.name} 失败`)) }
    reader.readAsDataURL(file)
  })
}
