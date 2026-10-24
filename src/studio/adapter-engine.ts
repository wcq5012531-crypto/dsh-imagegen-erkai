/**
 * dsh-imagegen-studio — the adapter execution engine.
 *
 * `adapter-spec.ts` describes a protocol; this module speaks it. One code path
 * serves both pipelines, because the difference between "an image gateway" and
 * "a video gateway" is only whether the answer arrives immediately or after a
 * poll — which is a property of the adapter, not of the engine.
 *
 * The engine is deliberately narrow about what it will send: the URL, headers and
 * body all come from the adapter description, and the only thing this file adds
 * is the credential, the parameter values the panel collected, and the reference
 * media the request carried.
 */

import type { GeneratedImage, GenerateResult } from '../protocol.ts'
import type { VideoBytes, VideoEngineResult } from '../video-engine.ts'
import {
  DEFAULT_DONE_VALUES,
  DEFAULT_FAILED_VALUES,
  DEFAULT_FIELDS,
  readFirstString,
  readJsonPath,
  readStringList,
  renderJsonTemplate,
  resolveFields,
  type AdapterFieldMap,
  type AdapterModelSpec,
  type AdapterProfile,
  type FieldName,
} from './adapter-spec.ts'
import type { StudioParamRole, StudioWireExtras } from './param-schema.ts'

/** Everything the panel knows when it asks an adapter to render. */
export interface AdapterRenderParams {
  prompt: string
  /** Upstream model id (already mapped from the alias). */
  model: string
  /** Pixel size such as `1024x1024`, or `auto`. */
  size?: string
  /** Aspect ratio such as `16:9`. */
  aspect?: string
  /** Resolution tier such as `720P` / `2k`. */
  resolution?: string
  /** Clip length in seconds. */
  duration?: number
  n?: number
  seed?: number
  negativePrompt?: string
  /** Reference images as `data:` URIs, in request order. */
  images?: string[]
  firstFrame?: string
  lastFrame?: string
  /** Reference videos / audios as `data:` URIs. */
  videos?: string[]
  audios?: string[]
  /**
   * Free-form wire writes resolved from the model's declared parameter schema.
   *
   * They are applied last, after the classic field map and after the model's
   * static `extra`, so an explicit user value always wins over a preset. Body
   * keys merge into the JSON/multipart body, query keys append to the URL and
   * header keys override the credentialed headers.
   */
  custom?: StudioWireExtras
}

/** A request as it would go on the wire. Credentials are redacted. */
export interface AdapterWirePreview {
  url: string
  method: string
  headers: Record<string, string>
  /** The body that will be sent, or a summary for multipart. */
  body: unknown
  contentType: string
  /** Fields this adapter will not send because it does not define them. */
  omitted: string[]
}

/** Progress events so a long poll is not a silent spinner. */
export interface AdapterProgress {
  phase: 'submit' | 'poll' | 'download'
  message: string
  progress?: number
  taskId?: string
}

export interface AdapterRunOptions {
  signal?: AbortSignal
  onProgress?: (event: AdapterProgress) => void
  fetchFn?: typeof fetch
}

/** Raised for every adapter-level failure, with the phase that failed. */
export class AdapterError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AdapterError'
  }
}

const SUBMIT_TIMEOUT_MS = 120_000
const DOWNLOAD_TIMEOUT_MS = 300_000
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/** Find the model spec for an alias, falling back to the raw id. */
export function adapterModel(adapter: AdapterProfile, alias: string): AdapterModelSpec | undefined {
  return adapter.models.find(model => model.alias === alias)
    ?? adapter.models.find(model => model.id === alias)
    ?? (adapter.models.length === 1 ? adapter.models[0] : undefined)
}

/** Capability defaults for a model that declares none. */
export function modelCapabilities(model: AdapterModelSpec | undefined, kind: AdapterProfile['kind']): {
  aspectRatios: string[]
  resolutions: string[]
  durations: number[]
  maxRefImages: number
} {
  return {
    aspectRatios: model?.aspectRatios ?? ['16:9', '9:16', '1:1'],
    resolutions: model?.resolutions ?? (kind === 'video' ? ['480P', '720P', '1080P'] : ['1k', '2k']),
    durations: model?.durations ?? (kind === 'video' ? [5, 10] : []),
    maxRefImages: model?.maxRefImages ?? 0,
  }
}

/** Join the adapter's origin with a submit/poll path template. */
function resolveUrl(adapter: AdapterProfile, path: string): string {
  const trimmed = path.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  const base = adapter.baseUrl.trim().replace(/\/+$/, '')
  return `${base}/${trimmed.replace(/^\/+/, '')}`
}

/** Headers with the credential applied, credential itself included. */
function credentialedHeaders(adapter: AdapterProfile, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(adapter.submit.headers ?? {}), ...(extra ?? {}) }
  const token = adapter.auth.token.trim()
  if (token !== '' && adapter.auth.style !== 'none' && adapter.auth.style !== 'query') {
    const prefix = adapter.auth.prefix ?? (adapter.auth.style === 'bearer' ? 'Bearer ' : '')
    const name = adapter.auth.style === 'bearer' ? 'Authorization' : (adapter.auth.headerName ?? 'Authorization')
    headers[name] = `${prefix}${token}`
  }
  return headers
}

/** Redact every credential-bearing header for display. */
export function redactHeaders(adapter: AdapterProfile, headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    const secret = /authorization|api[-_]?key|token|secret|cookie/i.test(name)
    out[name] = secret ? `${value.slice(0, Math.min(value.length, 12))}…(已隐藏)` : value
  }
  return out
}

/** Apply the query-style credential to a URL. */
function withQueryToken(adapter: AdapterProfile, url: string): string {
  if (adapter.auth.style !== 'query') return url
  const name = adapter.auth.queryName?.trim()
  const token = adapter.auth.token.trim()
  if (name === undefined || name === '' || token === '') return url
  const parsed = new URL(url)
  parsed.searchParams.set(name, token)
  return parsed.toString()
}

/** Split a `data:` URI into mime + base64 payload. */
function splitDataUri(value: string): { mime: string; b64: string } | undefined {
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.*)$/s.exec(value.trim())
  if (match === null) return undefined
  return { mime: match[1], b64: match[2] }
}

/** Decode any string that is either a data URI or bare base64. */
function toBytes(value: string): { bytes: Buffer; mime: string } {
  const dataUri = splitDataUri(value)
  if (dataUri !== undefined) return { bytes: Buffer.from(dataUri.b64, 'base64'), mime: dataUri.mime }
  return { bytes: Buffer.from(value, 'base64'), mime: 'application/octet-stream' }
}

/** Guess a MIME type from the first bytes of an asset. */
export function sniffMime(bytes: Buffer, fallback: string): string {
  if (bytes.length >= 12) {
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
    if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
    if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm'
  }
  return fallback
}

/** Canonical roles and the field-map slot each one drives. */
const ROLE_FIELDS: Record<Exclude<StudioParamRole, 'custom'>, keyof AdapterFieldMap> = {
  model: 'model',
  prompt: 'prompt',
  size: 'size',
  aspect: 'aspect',
  resolution: 'resolution',
  duration: 'duration',
  n: 'n',
  seed: 'seed',
  negativePrompt: 'negativePrompt',
}

/**
 * Point the canonical field map at the wire names a model declared.
 *
 * A parameter that claims a role (`resolution`, `duration`, …) is already
 * written by the parameter layer under its own `name`. Without this step the
 * engine writes the same knob a second time under the default name, and a
 * gateway that validates its body rejects the pair (`quality` beside
 * `resolution`, `seconds` beside `duration`). So a declared role wins over the
 * field map, and a role aimed at a query parameter or a header switches the
 * body write off instead of guessing where it belongs.
 */
function applyRoleNames(fields: AdapterFieldMap, model: AdapterModelSpec | undefined): void {
  const names = fields as unknown as Record<string, FieldName>
  for (const param of model?.params ?? []) {
    const role = param.role ?? 'custom'
    if (role === 'custom') continue
    const name = typeof param.name === 'string' && param.name.trim() !== '' ? param.name.trim() : param.key
    const target = param.target ?? 'body'
    names[ROLE_FIELDS[role]] = target === 'body' ? name : null
  }
}

/**
 * Build the request an adapter describes.
 *
 * Exported because the editor renders it as the dry-run preview: seeing the
 * exact URL, headers and body before spending money is the whole point of a
 * user-defined protocol layer.
 */
export function planAdapterRequest(
  adapter: AdapterProfile,
  model: AdapterModelSpec | undefined,
  params: AdapterRenderParams,
): { url: string; method: string; headers: Record<string, string>; body?: unknown; contentType: string; preview: AdapterWirePreview } {
  const fields = resolveFields(DEFAULT_FIELDS as AdapterFieldMap, adapter.fields, model?.fieldOverrides) as AdapterFieldMap
  applyRoleNames(fields, model)
  const omitted: string[] = []
  const images = (params.images ?? []).filter(value => value.trim() !== '')
  const imageMode = typeof fields.imageMode === 'string' ? fields.imageMode : 'data-uri-array'
  const multipart = imageMode === 'multipart-file'

  const values: Record<string, string | number | undefined> = {
    prompt: params.prompt,
    model: params.model,
    n: params.n,
    seed: params.seed,
    negative_prompt: params.negativePrompt,
    duration: params.duration,
    resolution: params.resolution,
    aspect: params.aspect,
    size: undefined,
    image: undefined,
    images: undefined,
    first_frame: undefined,
    last_frame: undefined,
  }

  // Size: the ratio table wins, because a gateway that wants pixels cannot take
  // a ratio, and one that wants a ratio should not be sent pixels.
  const ratio = params.aspect?.trim() ?? ''
  const pixel = params.size?.trim() ?? ''
  if (fields.sizeByRatio !== undefined && ratio !== '' && fields.sizeByRatio[ratio] !== undefined) {
    values.size = fields.sizeByRatio[ratio]
  } else if (pixel !== '' && pixel !== 'auto') {
    values.size = pixel
  } else if (ratio !== '' && typeof fields.size === 'string' && typeof fields.aspect !== 'string') {
    values.size = ratio
  }

  if (imageMode === 'first-last-object') {
    values.first_frame = params.firstFrame ?? images[0]
    values.last_frame = params.lastFrame
  } else {
    values.image = images[0]
    values.images = images.length === 0 ? undefined : JSON.stringify(images)
  }

  let body: Record<string, unknown>
  if (adapter.submit.bodyTemplate !== undefined && adapter.submit.bodyTemplate.trim() !== '') {
    body = renderJsonTemplate(adapter.submit.bodyTemplate, values)
    if (multipart && images.length > 0) omitted.push('multipart 与 JSON 模板同时存在：已按 JSON 模板发送，参考图未上传')
  } else {
    body = {}
    // `null` is a deliberate "this gateway takes no such parameter": the value
    // is dropped and reported, so the preview explains the absence instead of
    // leaving the user wondering why a control does nothing.
    const set = (field: FieldName | undefined, value: unknown, label: string): void => {
      if (typeof field !== 'string' || field === '') { if (value !== undefined) omitted.push(label); return }
      if (value === undefined || value === '') return
      body[field] = value
    }
    set(fields.model, params.model, 'model')
    set(fields.prompt, params.prompt, 'prompt')
    if (values.size !== undefined) set(fields.size, values.size, 'size')
    else if (pixel !== '' && typeof fields.size !== 'string' && typeof fields.aspect === 'string') omitted.push('size')
    set(fields.aspect, params.aspect === 'auto' ? undefined : params.aspect, 'aspect_ratio')
    set(fields.resolution, params.resolution, 'resolution')
    set(fields.duration, params.duration, 'duration')
    set(fields.n, params.n, 'n')
    set(fields.seed, params.seed, 'seed')
    set(fields.negativePrompt, params.negativePrompt, 'negative_prompt')

    if (images.length > 0) {
      const field = typeof fields.image === 'string' ? fields.image : undefined
      if (imageMode === 'first-last-object') {
        const firstKey = typeof fields.firstFrame === 'string' ? fields.firstFrame : undefined
        const lastKey = typeof fields.lastFrame === 'string' ? fields.lastFrame : undefined
        if (firstKey === undefined) omitted.push('first_frame')
        else body[firstKey] = params.firstFrame ?? images[0]
        if (lastKey === undefined) {
          if (params.lastFrame !== undefined) omitted.push('last_frame')
        } else if (params.lastFrame !== undefined) {
          body[lastKey] = params.lastFrame
        }
      } else if (field === undefined) {
        omitted.push('image')
      } else if (imageMode === 'single-data-uri') {
        body[field] = images[0]
      } else if (imageMode === 'base64-array') {
        body[field] = images.map((value) => splitDataUri(value)?.b64 ?? value)
      } else if (imageMode === 'url-array' || imageMode === 'multipart-file') {
        body[field] = images
      } else {
        body[field] = images
      }
    }
    if (params.videos !== undefined && params.videos.length > 0) {
      if (typeof fields.refVideos === 'string') body[fields.refVideos] = params.videos
      else omitted.push('reference_videos')
    }
    if (params.audios !== undefined && params.audios.length > 0) {
      if (typeof fields.refAudios === 'string') body[fields.refAudios] = params.audios
      else omitted.push('reference_audios')
    }
  }
  if (model?.extra !== undefined) Object.assign(body, model.extra)
  // Free-form schema values land last so an explicit user value beats a preset.
  if (params.custom?.body !== undefined) Object.assign(body, params.custom.body)

  const headers = credentialedHeaders(adapter, params.seed !== undefined ? {} : {})
  if (params.custom?.headers !== undefined) Object.assign(headers, params.custom.headers)
  let contentType = 'application/json'
  let payload: unknown = body
  if (adapter.submit.contentType === 'query' && adapter.submit.method !== 'GET') {
    contentType = 'application/x-www-form-urlencoded'
  } else if (multipart) {
    // Returned as a plain object; the sender turns it into FormData below.
    contentType = 'multipart/form-data'
  } else {
    headers['content-type'] = headers['content-type'] ?? 'application/json'
  }

  const rawUrl = resolveUrl(adapter, adapter.submit.path)
  const url = withQueryToken(adapter, rawUrl)
  let finalUrl = url
  if (adapter.submit.contentType === 'query' && adapter.submit.method === 'GET') {
    const parsed = new URL(url)
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null || typeof value === 'object') continue
      parsed.searchParams.set(key, String(value))
    }
    finalUrl = parsed.toString()
    payload = undefined
  }

  // Schema-declared query parameters travel on every method, because a gateway
  // that wants them in the URL does not care whether the body is a form or JSON.
  const queryExtras = params.custom?.query
  if (queryExtras !== undefined && Object.keys(queryExtras).length > 0) {
    const parsed = new URL(finalUrl)
    for (const [key, value] of Object.entries(queryExtras)) parsed.searchParams.set(key, value)
    finalUrl = parsed.toString()
  }

  const preview: AdapterWirePreview = {
    url: finalUrl,
    method: adapter.submit.method,
    headers: redactHeaders(adapter, headers),
    body: payload,
    contentType,
    omitted: [...new Set(omitted)],
  }
  return { url: finalUrl, method: adapter.submit.method, headers, body: payload, contentType, preview }
}

/** Wait for `ms`, aborting early when the signal fires. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new AdapterError('已取消', 'aborted')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new AdapterError('已取消', 'aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** One HTTP call with a timeout and a JSON-shaped failure. */
async function callJson(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  phase: 'submit' | 'poll',
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const forward = (): void => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      if (RETRYABLE_STATUS.has(response.status) && phase === 'poll') {
        throw new AdapterError(`网关返回 HTTP ${response.status}（稍后重试）：${text.slice(0, 300)}`, 'retryable')
      }
      throw new AdapterError(`网关返回 HTTP ${response.status}：${text.slice(0, 500)}`, `${phase}-failed`)
    }
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new AdapterError(`网关返回的不是 JSON：${text.slice(0, 300)}`, 'bad-json')
    }
  } catch (error) {
    if (error instanceof AdapterError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new AdapterError(`${phase === 'submit' ? '提交' : '轮询'}请求失败：${message}`, `${phase}-failed`)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/** Turn the plan into a fetch init, handling the multipart variant. */
function toInit(plan: ReturnType<typeof planAdapterRequest>, params: AdapterRenderParams): RequestInit {
  if (plan.contentType === 'multipart/form-data') {
    const form = new FormData()
    const body = (plan.body ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item.startsWith('data:')) {
            const decoded = splitDataUri(item)
            if (decoded !== undefined) {
              form.append(key, new Blob([Buffer.from(decoded.b64, 'base64')], { type: decoded.mime }), `${key}.${decoded.mime.split('/')[1] ?? 'bin'}`)
              continue
            }
          }
          form.append(key, typeof item === 'string' ? item : JSON.stringify(item))
        }
        continue
      }
      if (typeof value === 'string' && value.startsWith('data:')) {
        const decoded = splitDataUri(value)
        if (decoded !== undefined) {
          form.append(key, new Blob([Buffer.from(decoded.b64, 'base64')], { type: decoded.mime }), `${key}.${decoded.mime.split('/')[1] ?? 'bin'}`)
          continue
        }
      }
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
    }
    const headers = { ...plan.headers }
    // The browser/runtime must set the multipart boundary itself.
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-type') delete headers[name]
    void params
    return { method: plan.method, headers, body: form }
  }
  if (plan.contentType === 'application/x-www-form-urlencoded' && plan.body !== undefined) {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(plan.body as Record<string, unknown>)) {
      if (value === undefined || value === null || typeof value === 'object') continue
      form.set(key, String(value))
    }
    return { method: plan.method, headers: plan.headers, body: form.toString() }
  }
  return {
    method: plan.method,
    headers: plan.headers,
    ...plan.body === undefined ? {} : { body: JSON.stringify(plan.body) },
  }
}

/** Download one finished asset, following the adapter's auth setting. */
async function downloadAsset(
  adapter: AdapterProfile,
  url: string,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; mime: string }> {
  const headers = adapter.result.downloadAuth === true ? credentialedHeaders(adapter) : {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const forward = (): void => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const response = await fetchFn(url, { headers, signal: controller.signal })
    if (!response.ok) throw new AdapterError(`下载结果失败：HTTP ${response.status}`, 'download-failed')
    const length = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(length) && length > MAX_ASSET_BYTES) {
      throw new AdapterError(`结果文件过大（${Math.round(length / 1048576)}MB）`, 'download-too-large')
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength > MAX_ASSET_BYTES) throw new AdapterError('结果文件过大', 'download-too-large')
    const declared = response.headers.get('content-type') ?? 'application/octet-stream'
    return { bytes: buffer, mime: sniffMime(buffer, declared.split(';')[0].trim()) }
  } catch (error) {
    if (error instanceof AdapterError) throw error
    throw new AdapterError(`下载结果失败：${error instanceof Error ? error.message : String(error)}`, 'download-failed')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/** Everything one adapter run produced, before it becomes a typed result. */
interface AdapterAssets {
  taskId?: string
  /** Final response the asset paths were read from. */
  payload: unknown
}

/** Submit, and poll when the adapter declares a poll step. */
async function execute(
  adapter: AdapterProfile,
  model: AdapterModelSpec | undefined,
  params: AdapterRenderParams,
  options: AdapterRunOptions,
): Promise<AdapterAssets> {
  const fetchFn = options.fetchFn ?? fetch
  const plan = planAdapterRequest(adapter, model, params)
  options.onProgress?.({ phase: 'submit', message: `提交到 ${adapter.label}` })
  const submitPayload = await callJson(fetchFn, plan.url, toInit(plan, params), 'submit', SUBMIT_TIMEOUT_MS, options.signal)

  const poll = adapter.poll
  if (poll === undefined) return { payload: submitPayload }

  const taskId = readFirstString(submitPayload, [poll.taskIdPath, 'task_id', 'id', 'data.task_id', 'data.id'])
  if (taskId === undefined) {
    // Some gateways answer synchronously even when the docs imply a task. If the
    // submit response already carries an asset, use it instead of failing.
    const hasAsset = (adapter.result.urlPaths ?? []).some(path => readJsonPath(submitPayload, path).length > 0)
    if (hasAsset) return { payload: submitPayload }
    throw new AdapterError(`提交响应里找不到任务 ID（配置的路径：${poll.taskIdPath}）`, 'no-task-id')
  }
  options.onProgress?.({ phase: 'poll', message: `任务 ${taskId} 已提交，等待渲染`, taskId })

  const interval = Math.max(1000, poll.intervalMs ?? 3000)
  const deadline = Date.now() + Math.max(30_000, poll.timeoutMs ?? 15 * 60_000)
  const done = new Set(poll.doneValues ?? DEFAULT_DONE_VALUES)
  const failed = new Set(poll.failedValues ?? DEFAULT_FAILED_VALUES)
  let last: unknown = submitPayload

  for (;;) {
    if (Date.now() > deadline) {
      throw new AdapterError(`任务 ${taskId} 轮询超时（${Math.round((poll.timeoutMs ?? 900_000) / 1000)}s）`, 'poll-timeout')
    }
    await sleep(interval, options.signal)
    const pollUrl = withQueryToken(adapter, resolveUrl(adapter, poll.path.replace(/\{\{\s*taskId\s*\}\}/g, taskId)))
    const headers = credentialedHeaders(adapter)
    const method = poll.method ?? 'GET'
    let payload: unknown
    try {
      payload = await callJson(fetchFn, pollUrl, { method, headers }, 'poll', 60_000, options.signal)
    } catch (error) {
      if (error instanceof AdapterError && error.code === 'retryable') continue
      throw error
    }
    last = payload
    const status = poll.statusPath === undefined ? undefined : readFirstString(payload, [poll.statusPath])
    const errorText = poll.errorPath === undefined ? undefined : readFirstString(payload, [poll.errorPath])
    const progressRaw = poll.progressPath === undefined ? undefined : readFirstString(payload, [poll.progressPath])
    const progress = progressRaw === undefined ? undefined : Number(progressRaw)
    options.onProgress?.({
      phase: 'poll',
      message: `任务 ${taskId}：${status ?? '进行中'}`,
      ...Number.isFinite(progress) ? { progress } : {},
      taskId,
    })
    if (status !== undefined && failed.has(status)) {
      throw new AdapterError(`任务失败：${status}${errorText === undefined ? '' : `：${errorText}`}`, 'task-failed')
    }
    if (status !== undefined && done.has(status)) return { taskId, payload }
    // No status field at all: treat the presence of an asset as completion.
    if (status === undefined) {
      const hasAsset = (adapter.result.urlPaths ?? []).some(path => readJsonPath(payload, path).length > 0)
        || (adapter.result.b64Paths ?? []).some(path => readJsonPath(payload, path).length > 0)
      if (hasAsset) return { taskId, payload }
    }
    void last
  }
}

/** Collect every asset reference the adapter's result spec points at. */
function readAssetRefs(adapter: AdapterProfile, payload: unknown): { urls: string[]; b64: string[]; mime?: string; revisedPrompt?: string } {
  const urls: string[] = []
  for (const path of adapter.result.urlPaths ?? []) urls.push(...readStringList(payload, path))
  const b64: string[] = []
  for (const path of adapter.result.b64Paths ?? []) b64.push(...readStringList(payload, path))
  return {
    urls: [...new Set(urls)],
    b64: [...new Set(b64)],
    ...adapter.result.mimePath === undefined ? {} : (() => {
      const mime = readFirstString(payload, [adapter.result.mimePath])
      return mime === undefined ? {} : { mime }
    })(),
    ...adapter.result.revisedPromptPath === undefined ? {} : (() => {
      const revised = readFirstString(payload, [adapter.result.revisedPromptPath])
      return revised === undefined ? {} : { revisedPrompt: revised }
    })(),
  }
}

/** Run one adapter render and normalize it into `GenerateResult`. */
export async function runAdapterImage(
  adapter: AdapterProfile,
  model: AdapterModelSpec | undefined,
  params: AdapterRenderParams,
  options: AdapterRunOptions = {},
): Promise<GenerateResult> {
  const { payload } = await execute(adapter, model, params, options)
  const refs = readAssetRefs(adapter, payload)
  const images: GeneratedImage[] = []
  for (const url of refs.urls) {
    options.onProgress?.({ phase: 'download', message: '下载生成结果' })
    const asset = await downloadAsset(adapter, url, options.fetchFn ?? fetch, options.signal)
    images.push({ b64: asset.bytes.toString('base64'), mime: asset.mime, ...refs.revisedPrompt === undefined ? {} : { revisedPrompt: refs.revisedPrompt } })
  }
  for (const value of refs.b64) {
    const decoded = toBytes(value)
    images.push({
      b64: decoded.bytes.toString('base64'),
      mime: sniffMime(decoded.bytes, refs.mime ?? decoded.mime),
      ...refs.revisedPrompt === undefined ? {} : { revisedPrompt: refs.revisedPrompt },
    })
  }
  if (images.length === 0) {
    throw new AdapterError('适配器没有从响应中取到任何图片；请检查“结果路径”（urlPaths / b64Paths）', 'no-asset')
  }
  return { images }
}

/** Run one adapter render and normalize it into `VideoEngineResult`. */
export async function runAdapterVideo(
  adapter: AdapterProfile,
  model: AdapterModelSpec | undefined,
  params: AdapterRenderParams,
  options: AdapterRunOptions = {},
): Promise<VideoEngineResult> {
  const { payload } = await execute(adapter, model, params, options)
  const refs = readAssetRefs(adapter, payload)
  const videos: VideoBytes[] = []
  for (const url of refs.urls) {
    options.onProgress?.({ phase: 'download', message: '下载视频结果' })
    const asset = await downloadAsset(adapter, url, options.fetchFn ?? fetch, options.signal)
    videos.push({
      bytes: asset.bytes,
      mime: asset.mime,
      sourceUrl: url,
      ...params.duration === undefined ? {} : { duration: params.duration },
      ...refs.revisedPrompt === undefined ? {} : { revisedPrompt: refs.revisedPrompt },
    })
  }
  for (const value of refs.b64) {
    const decoded = toBytes(value)
    videos.push({
      bytes: decoded.bytes,
      mime: sniffMime(decoded.bytes, refs.mime ?? decoded.mime),
      sourceUrl: '',
      ...params.duration === undefined ? {} : { duration: params.duration },
    })
  }
  if (videos.length === 0) {
    throw new AdapterError('适配器没有从响应中取到任何视频；请检查“结果路径”（urlPaths）', 'no-asset')
  }
  return { videos }
}

/** A one-shot connectivity probe that does not download or spend anything extra. */
export async function probeAdapter(
  adapter: AdapterProfile,
  model: AdapterModelSpec | undefined,
  options: { prompt?: string; output?: 'none' } & AdapterRunOptions = {},
): Promise<{ ok: boolean; taskId?: string; status?: string; excerpt: string; detectedUrls: string[] }> {
  const fetchFn = options.fetchFn ?? fetch
  const params: AdapterRenderParams = {
    prompt: options.prompt ?? 'probe',
    model: model?.id ?? '{{model}}',
    n: 1,
  }
  const plan = planAdapterRequest(adapter, model, params)
  const payload = await callJson(fetchFn, plan.url, toInit(plan, params), 'submit', SUBMIT_TIMEOUT_MS, options.signal)
  const refs = readAssetRefs(adapter, payload)
  const taskId = adapter.poll === undefined ? undefined : readFirstString(payload, [adapter.poll.taskIdPath, 'id', 'task_id', 'data.id'])
  const status = adapter.poll?.statusPath === undefined ? undefined
    : readFirstString(payload, [adapter.poll.statusPath])
  return {
    ok: true,
    ...taskId === undefined ? {} : { taskId },
    ...status === undefined ? {} : { status },
    excerpt: JSON.stringify(payload).slice(0, 2000),
    detectedUrls: refs.urls,
  }
}
