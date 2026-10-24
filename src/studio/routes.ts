/**
 * Studio routes: adapters, discovery, wire preview, chat generation, and
 * tail-frame continuation.
 *
 * Everything a "friendly integration" needs lives behind these endpoints:
 *
 *  - the adapter store (`GET/POST adapters`) so a gateway is described once, not
 *    hard-coded into the panel;
 *  - `discover` so the model list is read off the gateway instead of typed by
 *    hand;
 *  - `preview` which renders the exact URL, headers and body *without sending
 *    it* — the cheapest way to debug a gateway that keeps answering 400;
 *  - `generate` / `continuum`, both asynchronous with a poll and a cancel, since
 *    a video render outlives any sane HTTP request.
 *
 * No credential ever leaves this process: profiles go out masked, and the token
 * is read from the store at request time.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

import {
  adapterModel,
  planAdapterRequest,
  runAdapterImage,
  runAdapterVideo,
  type AdapterRenderParams,
} from './adapter-engine.ts'
import { fieldsForSurface, resolveStudioParams } from './param-schema.ts'
import type { AdapterKind, AdapterModelSpec, AdapterProfile } from './adapter-spec.ts'
import { deriveChannelAdapters, splitChannelAdapterId, type StudioChannelConfig } from './channel-adapters.ts'
import { maskProfile, normalizeProfile, readAdapters, removeAdapter, saveAdapter, studioOutDir } from './store.ts'
import { cancelStudioTask, createStudioTask, readStudioTask, updateStudioTask } from './tasks.ts'
import { runContinuum, grabTailFrame } from './continuum.ts'
import { isLoopbackRequest, messageOf, readJsonBody, resolveInside, sendFile, writeJson } from './http.ts'
import {
  STUDIO_API,
  type StudioContinuumRequest,
  type StudioDiscoveredModel,
  type StudioDiscoverResult,
  type StudioGenerateRequest,
  type StudioParamState,
  type StudioPreviewResult,
} from './types.ts'

/** Model-id patterns used to classify what a gateway returns. */
const VIDEO_MODEL_PAT = /(video|veo|sora|kling|seedance|hailuo|vidu|pika|movie|t2v|i2v|r2v|s2v|wan[-_.]?\d|minimax[-_]?h3|grok-imagine-video|runway|pixverse|luma|ltx)/i
/** Image-model patterns. */
const IMAGE_MODEL_PAT = /(image|dall|flux|sdxl|sd[-_.]?\d|midjourney|banana|seedream|kolors|hidream|imagen|gpt-image|glm-image|qwen-image|recraft|ideogram|stable-diffusion|janus)/i
/**
 * Patterns for everything that is definitely not a media model. Checked first:
 * a gateway lists its chat models in the same endpoint, and offering `gpt-4o` as
 * an image model is worse than offering nothing.
 */
const NON_MEDIA_PAT = /(embed|rerank|whisper|tts|transcri|moderation|chat|instruct|vision-ocr|gpt-3|gpt-4(?!o-image)|gpt-5|o1|o3|claude|gemini-(?!.*image)|deepseek|llama|mistral|qwen-(max|plus|turbo|long)|text-|bge-|jina-)/i

/** Extensions per produced MIME. */
function extensionFor(mime: string): string {
  if (mime.includes('webm')) return 'webm'
  if (mime.includes('quicktime')) return 'mov'
  if (mime.includes('jpeg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.startsWith('video/')) return 'mp4'
  if (mime.startsWith('audio/')) return 'mp3'
  return 'png'
}

/**
 * Write one produced asset into the served directory.
 * @param bytes - the bytes.
 * @param mime - content type.
 * @param prefix - file-name prefix, for legibility in the folder.
 * @returns the served URL and its size.
 */
async function persistAsset(bytes: Buffer, mime: string, prefix: string): Promise<{ url: string; mime: string; bytes: number }> {
  const dir = studioOutDir()
  await fs.mkdir(dir, { recursive: true })
  const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extensionFor(mime)}`
  await fs.writeFile(path.join(dir, name), bytes)
  return { url: `${STUDIO_API.file}/${name}`, mime, bytes: bytes.byteLength }
}

/**
 * The model spec for a request, synthesising a bare one when the profile has no
 * entry for that alias (so an unlisted model is still tryable).
 * @param adapter - the profile.
 * @param alias - alias or raw id.
 */
function resolveModel(adapter: AdapterProfile, alias: string): AdapterModelSpec {
  return adapterModel(adapter, alias) ?? { alias, id: alias }
}

/** One fully resolved render, ready for the engine. */
interface PreparedRender {
  adapter: AdapterProfile
  model: AdapterModelSpec
  params: AdapterRenderParams
  warnings: string[]
}

/**
 * Turn a chat request into engine parameters.
 *
 * Precedence is deliberate: explicit request values win, then the model's
 * declared parameter roles, then the model's own defaults. That order is what
 * lets one panel serve a gateway where `nano-banana` spells size `image_size`
 * and `gpt-image-2` spells it `size` — both declare the same *role*.
 * @param raw - request body.
 * @param adapters - the adapters derived from the live channels.
 * @returns the prepared render, or a failure message.
 */
async function prepareGenerate(raw: Record<string, unknown>, adapters: readonly AdapterProfile[]): Promise<PreparedRender | { failure: string; warnings?: string[] }> {
  const adapterId = typeof raw.adapterId === 'string' ? raw.adapterId.trim() : ''
  const alias = typeof raw.modelAlias === 'string' ? raw.modelAlias.trim() : ''
  const prompt = typeof raw.prompt === 'string' ? raw.prompt : ''
  if (adapterId === '') return { failure: '缺少 adapterId' }
  if (alias === '') return { failure: '缺少 modelAlias' }
  if (prompt.trim() === '') return { failure: '提示词为空' }
  const adapter = adapters.find(entry => entry.id === adapterId)
  if (adapter === undefined) return { failure: `找不到通道 ${adapterId}：它对应的渠道可能已从设置里删除` }
  if (adapter.auth.style !== 'none' && adapter.auth.token.trim() === '') {
    return { failure: `通道「${adapter.label}」还没有 API Key：在「设置 → 生图配置」里打开该渠道填一个` }
  }
  const model = resolveModel(adapter, alias)
  const surface = raw.surface === 'edit' ? 'edit' : raw.surface === 'video' ? 'video' : 'image'
  const mediaImages = Array.isArray(raw.images) ? raw.images.length : 0
  const mediaVideos = Array.isArray(raw.videos) ? raw.videos.length : 0
  const mediaAudios = Array.isArray(raw.audios) ? raw.audios.length : 0
  // Fields that only make sense with media attached (`requires`) are filtered by
  // the same call the panel uses, so the wire and the controls cannot disagree.
  const fields = fieldsForSurface(model.params ?? [], surface, { images: mediaImages, videos: mediaVideos, audios: mediaAudios })
  const resolved = resolveStudioParams(fields, (raw.params !== null && typeof raw.params === 'object' ? raw.params : {}) as StudioParamState)
  const warnings = [...resolved.warnings]
  const listOf = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const out = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    return out.length === 0 ? undefined : out
  }
  const numberOf = (value: unknown): number | undefined => {
    const num = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(num) ? num : undefined
  }
  const images = listOf(raw.images)
  const videos = listOf(raw.videos)
  const audios = listOf(raw.audios)
  const firstFrame = typeof raw.firstFrame === 'string' && raw.firstFrame.trim() !== '' ? raw.firstFrame : undefined
  const lastFrame = typeof raw.lastFrame === 'string' && raw.lastFrame.trim() !== '' ? raw.lastFrame : undefined
  if (images !== undefined && images.length > (model.maxRefImages ?? 0)) {
    warnings.push(`该模型最多 ${String(model.maxRefImages ?? 0)} 张参考图，多余的已忽略`)
  }
  const capped = images === undefined ? undefined : images.slice(0, model.maxRefImages ?? 0)
  const params: AdapterRenderParams = {
    prompt,
    model: model.id,
    ...(typeof raw.aspect === 'string' && raw.aspect !== '' ? { aspect: raw.aspect } : resolved.roles.aspect === undefined ? {} : { aspect: resolved.roles.aspect }),
    ...(typeof raw.resolution === 'string' && raw.resolution !== '' ? { resolution: raw.resolution } : resolved.roles.resolution === undefined ? {} : { resolution: resolved.roles.resolution }),
    ...(typeof raw.size === 'string' && raw.size !== '' ? { size: raw.size } : resolved.roles.size === undefined ? {} : { size: resolved.roles.size }),
    ...(() => {
      const duration = numberOf(raw.duration) ?? resolved.roles.duration
      return duration === undefined ? {} : { duration }
    })(),
    ...(() => {
      const n = numberOf(raw.n) ?? resolved.roles.n
      return n === undefined ? {} : { n }
    })(),
    ...(() => {
      const seed = numberOf(raw.seed) ?? resolved.roles.seed
      return seed === undefined ? {} : { seed }
    })(),
    ...(typeof raw.negativePrompt === 'string' && raw.negativePrompt !== ''
      ? { negativePrompt: raw.negativePrompt }
      : resolved.roles.negativePrompt === undefined ? {} : { negativePrompt: resolved.roles.negativePrompt }),
    ...capped === undefined ? {} : { images: capped },
    ...firstFrame === undefined ? {} : { firstFrame },
    ...lastFrame === undefined ? {} : { lastFrame },
    ...videos === undefined ? {} : { videos },
    ...audios === undefined ? {} : { audios },
    ...Object.keys(resolved.extras.body ?? {}).length === 0 ? {} : { custom: resolved.extras },
  }
  return { adapter, model, params, warnings }
}

/**
 * Classify a model id.
 * @param id - upstream model id.
 * @returns the kind, or undefined for something that is not a media model.
 */
function classifyModel(id: string): AdapterKind | undefined {
  if (NON_MEDIA_PAT.test(id)) return undefined
  if (VIDEO_MODEL_PAT.test(id)) return 'video'
  if (IMAGE_MODEL_PAT.test(id)) return 'image'
  return undefined
}

/**
 * Fetch JSON with a timeout and the adapter's credential.
 * @param url - absolute URL.
 * @param adapter - credential source.
 * @param signal - cancellation.
 * @returns parsed JSON, or a thrown error.
 */
async function fetchJson(url: string, adapter: AdapterProfile, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const { auth } = adapter
  if (auth.style === 'bearer' && auth.token !== '') {
    headers[auth.headerName ?? 'Authorization'] = `${auth.prefix ?? 'Bearer '}${auth.token}`
  } else if (auth.style === 'header' && auth.token !== '') {
    headers[auth.headerName ?? 'x-api-key'] = `${auth.prefix ?? ''}${auth.token}`
  }
  let target = url
  if (auth.style === 'query' && auth.token !== '') {
    const join = target.includes('?') ? '&' : '?'
    target = `${target}${join}${encodeURIComponent(auth.queryName ?? 'key')}=${encodeURIComponent(auth.token)}`
  }
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, 20_000)
  const onAbort = (): void => { controller.abort() }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(target, { headers, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}：${text.slice(0, 300)}`)
    return text.trim() === '' ? {} : JSON.parse(text) as unknown
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Read the model list out of a gateway response.
 * @param payload - parsed JSON.
 * @returns ids found.
 */
function modelIds(payload: unknown): string[] {
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : Array.isArray(payload) ? payload as unknown[] : []
  const ids: string[] = []
  for (const entry of list) {
    if (typeof entry === 'string') { ids.push(entry); continue }
    if (entry === null || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : typeof item.model === 'string' ? item.model : ''
    if (id.trim() !== '') ids.push(id.trim())
  }
  return [...new Set(ids)]
}

/**
 * Read `/api/pricing` into an id → {description, price} table, when present.
 * @param payload - parsed JSON.
 */
function pricingTable(payload: unknown): Map<string, { description?: string; price?: string }> {
  const table = new Map<string, { description?: string; price?: string }>()
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const list = Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload as unknown[] : []
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : typeof item.model === 'string' ? item.model : ''
    if (id === '') continue
    const description = typeof item.description === 'string' ? item.description : undefined
    const price = typeof item.model_price === 'number' ? String(item.model_price)
      : typeof item.model_price === 'string' ? item.model_price
        : typeof item.price === 'string' ? item.price : undefined
    table.set(id, {
      ...description === undefined ? {} : { description },
      ...price === undefined ? {} : { price },
    })
  }
  return table
}

/** What the host injects into the studio routes. */
export interface StudioRouteDeps {
  /** The live channels from the settings document, keys included. */
  channels?: () => readonly StudioChannelConfig[]
  /**
   * Append models to a channel's catalogue. The settings document owns the
   * catalogue, so this is the only way "adopt this model" can stick.
   * @returns an error message, or undefined when the write was accepted.
   */
  adoptModels?: (channelId: string, kind: AdapterKind, models: ReadonlyArray<{ alias: string; id: string }>) => Promise<string | undefined>
}

/**
 * Route table for the studio surface.
 *
 * Adapters are derived from the live channels on every request: the settings
 * page owns endpoints, keys and model catalogues, while the stored override
 * file only adds what a channel row cannot express (per-model parameters, the
 * wire contract). A channel deleted in settings therefore stops existing here
 * without a reconciliation step in between.
 * @param deps - host services (live channels, catalogue writes).
 */
export function makeStudioRoutes(deps: StudioRouteDeps = {}): WebRoute[] {
  /** The adapters the current channels imply, stored overrides applied. */
  const resolveAdapters = async (): Promise<AdapterProfile[]> => {
    const channels = deps.channels?.() ?? []
    const stored = await readAdapters()
    return deriveChannelAdapters(channels, stored, channelId => channels.find(entry => entry.id === channelId)?.apiKey ?? '')
  }

  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { ok: false, code: 'method', message: `method not allowed: ${req.method ?? ''}` })
      return false
    }
    return true
  }

  const routes: WebRoute[] = [
    // ------------------------------------------------------------- adapters
    {
      kind: 'exact',
      path: STUDIO_API.adapters,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        try {
          const adapters = await resolveAdapters()
          writeJson(res, 200, { ok: true, adapters: adapters.map(maskProfile) })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'store-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: STUDIO_API.adapter,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请求体不是合法 JSON' })
          return
        }
        try {
          // The channel row owns the credential from now on, so the override
          // record is written without one: a plaintext key must never move into
          // `adapters.json`, and a stale one (from the earlier per-adapter key
          // field) is dropped on the next save.
          const raw = body.adapter ?? body
          const posted = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
          const auth = posted.auth !== null && typeof posted.auth === 'object' ? posted.auth as Record<string, unknown> : undefined
          const sanitized = auth === undefined ? raw : { ...posted, auth: { ...auth, token: '' } }
          const saved = await saveAdapter(sanitized, { forgetToken: true })
          if (saved.profile === undefined) {
            writeJson(res, 200, { ok: false, code: 'invalid-adapter', message: '通道配置无效', warnings: saved.warnings })
            return
          }
          // The key belongs to the channel, not this record: nagging about a
          // field the drawer deliberately omits would only confuse.
          const warnings = saved.warnings.filter(warning => !warning.startsWith('未填写密钥'))
          writeJson(res, 200, { ok: true, adapter: saved.profile, warnings })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'save-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: STUDIO_API.adapterDelete,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少 id' })
          return
        }
        try {
          const removed = await removeAdapter(id)
          writeJson(res, 200, { ok: true, removed })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'delete-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------- channel catalogue
    {
      kind: 'exact',
      path: STUDIO_API.adopt,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请求体不是合法 JSON' })
          return
        }
        const adapterId = typeof body.adapterId === 'string' ? body.adapterId.trim() : ''
        const requested = Array.isArray(body.models) ? body.models : []
        const models: Array<{ alias: string; id: string }> = []
        for (const entry of requested) {
          if (entry === null || typeof entry !== 'object') continue
          const item = entry as Record<string, unknown>
          const id = typeof item.id === 'string' ? item.id.trim() : ''
          if (id === '') continue
          models.push({ alias: typeof item.alias === 'string' && item.alias.trim() !== '' ? item.alias.trim() : id, id })
        }
        if (adapterId === '' || models.length === 0) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '缺少 adapterId 或 models' })
          return
        }
        if (deps.adoptModels === undefined) {
          writeJson(res, 200, { ok: false, code: 'unsupported', message: '宿主没有注入渠道写入能力' })
          return
        }
        try {
          const { channelId, kind } = splitChannelAdapterId(adapterId)
          const failure = await deps.adoptModels(channelId, kind, models)
          if (failure !== undefined) {
            writeJson(res, 200, { ok: false, code: 'adopt-failed', message: failure })
            return
          }
          writeJson(res, 200, { ok: true, added: models.length })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'adopt-failed', message: messageOf(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: STUDIO_API.diag,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请求体不是合法 JSON' })
          return
        }
        try {
          // A fresh profile has no out dir yet; create it before appending.
          const logDir = studioOutDir()
          await fs.mkdir(logDir, { recursive: true })
          await fs.appendFile(path.join(logDir, 'stall.log'), `${JSON.stringify(body)}\n`, 'utf8')
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'diag-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------------------ discovery
    {
      kind: 'exact',
      path: STUDIO_API.discover,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请求体不是合法 JSON' })
          return
        }
        try {
          // Probing an unsaved draft is allowed: the settings card should be able
          // to validate what the user is typing, before it is written anywhere.
          // The draft is normalized the same way a save would normalize it, and
          // an empty token in the draft inherits the stored one.
          let adapter: AdapterProfile | undefined
          const draft = body.adapter
          if (draft !== null && typeof draft === 'object') {
            const stored = (await readAdapters()).find(entry => entry.id === (draft as Record<string, unknown>).id)
            adapter = normalizeProfile(draft, stored).profile
          } else {
            const id = typeof body.adapterId === 'string' ? body.adapterId : ''
            adapter = (await resolveAdapters()).find(entry => entry.id === id)
          }
          if (adapter === undefined) {
            writeJson(res, 200, { ok: false, code: 'no-adapter', message: '找不到通道' })
            return
          }
          const modelsPath = typeof body.modelsPath === 'string' && body.modelsPath.trim() !== '' ? body.modelsPath.trim() : '/v1/models'
          const endpoint = /^https?:\/\//i.test(modelsPath) ? modelsPath : `${adapter.baseUrl}${modelsPath.startsWith('/') ? '' : '/'}${modelsPath}`
          const payload = await fetchJson(endpoint, adapter)
          let pricing = new Map<string, { description?: string; price?: string }>()
          try {
            const pricingPath = typeof body.pricingPath === 'string' && body.pricingPath.trim() !== '' ? body.pricingPath.trim() : '/api/pricing'
            pricing = pricingTable(await fetchJson(/^https?:\/\//i.test(pricingPath) ? pricingPath : `${adapter.baseUrl}${pricingPath.startsWith('/') ? '' : '/'}${pricingPath}`, adapter))
          } catch {
            // Pricing is a convenience; a gateway without it is still usable.
          }
          const known = new Set(adapter.models.map(model => model.id))
          const models: StudioDiscoveredModel[] = []
          for (const id of modelIds(payload)) {
            const kind = classifyModel(id)
            if (kind === undefined) continue
            const meta = pricing.get(id)
            models.push({
              id,
              alias: id,
              kind,
              known: known.has(id),
              ...meta?.price === undefined ? {} : { priceNote: `≈${meta.price}` },
              ...meta?.description === undefined ? {} : { description: meta.description },
            })
          }
          const result: StudioDiscoverResult = {
            ok: true,
            endpoint,
            models: models.sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)),
            hint: models.length === 0 ? '端点有响应，但没有识别出图片/视频模型：可以在“模型”里手工填一个 id' : undefined,
          }
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'discover-failed', message: messageOf(error) })
        }
      },
    },
    // --------------------------------------------------------- wire preview
    {
      kind: 'exact',
      path: STUDIO_API.preview,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请求体不是合法 JSON' })
          return
        }
        try {
          // The editor previews the draft it is holding, not the copy on disk:
          // the body has to be visible before anything is saved, which is the
          // only way to debug a gateway that silently ignores a parameter.
          let adapters: readonly AdapterProfile[] = []
          const draft = body.adapter
          if (draft !== null && typeof draft === 'object') {
            const stored = (await readAdapters()).find(entry => entry.id === (draft as Record<string, unknown>).id)
            const normalized = normalizeProfile(draft, stored).profile
            if (normalized === undefined) {
              writeJson(res, 200, { ok: false, code: 'invalid', message: '通道草稿不完整，无法预览' })
              return
            }
            // A brand-new channel has no key yet; the preview only needs a value
            // to redact, so a placeholder stands in until the user saves one.
            adapters = [normalized.auth.style !== 'none' && normalized.auth.token.trim() === ''
              ? { ...normalized, auth: { ...normalized.auth, token: 'preview-token' } }
              : normalized]
          } else {
            adapters = await resolveAdapters()
          }
          const prepared = await prepareGenerate({ ...body, prompt: typeof body.prompt === 'string' && body.prompt.trim() !== '' ? body.prompt : 'preview' }, adapters)
          if ('failure' in prepared) {
            writeJson(res, 200, { ok: false, code: 'invalid', message: prepared.failure })
            return
          }
          const plan = planAdapterRequest(prepared.adapter, prepared.model, prepared.params)
          const wire = plan.preview
          const declared = fieldsForSurface(prepared.model.params ?? [], body.surface === 'video' ? 'video' : body.surface === 'edit' ? 'edit' : 'image')
          const sentBody = plan.body !== null && typeof plan.body === 'object' ? plan.body as Record<string, unknown> : {}
          const result: StudioPreviewResult = {
            ok: true,
            url: plan.url,
            method: plan.method,
            headers: plan.headers,
            body: plan.body,
            contentType: plan.contentType,
            omitted: wire.omitted,
            unused: declared.map(field => field.key).filter(key => !(key in sentBody)),
          }
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 200, { ok: false, code: 'preview-failed', message: messageOf(error) })
        }
      },
    },
    // ------------------------------------------------------------ generation
    {
      kind: 'exact',
      path: STUDIO_API.generate,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请求体不是合法 JSON' })
          return
        }
        const prepared = await prepareGenerate(body, await resolveAdapters())
        if ('failure' in prepared) {
          writeJson(res, 200, { ok: false, code: 'invalid', message: prepared.failure })
          return
        }
        const request = body as unknown as StudioGenerateRequest
        const isVideo = request.surface === 'video' || prepared.adapter.kind === 'video'
        const { id, controller } = createStudioTask(isVideo ? 'video' : 'image')
        updateStudioTask(id, {
          state: 'running',
          phase: '提交',
          message: prepared.warnings.length === 0 ? '已提交到网关' : `已提交到网关（${prepared.warnings.join('；')}）`,
        })
        void (async () => {
          try {
            if (isVideo) {
              const result = await runAdapterVideo(prepared.adapter, prepared.model, prepared.params, {
                signal: controller.signal,
                onProgress: event => {
                  updateStudioTask(id, {
                    phase: event.phase === 'poll' ? '生成中' : event.phase === 'download' ? '下载' : '提交',
                    message: event.message,
                    ...event.progress === undefined ? {} : { progress: event.progress },
                  })
                },
              })
              const clip = result.videos[0]
              if (clip === undefined) throw new Error('网关没有返回视频')
              const asset = await persistAsset(clip.bytes, clip.mime, 'video')
              updateStudioTask(id, {
                state: 'done',
                phase: '完成',
                message: '已完成',
                progress: 100,
                result: {
                  kind: 'video',
                  video: {
                    ...asset,
                    ...clip.duration === undefined ? {} : { duration: clip.duration },
                    ...clip.revisedPrompt === undefined ? {} : { revisedPrompt: clip.revisedPrompt },
                  },
                  ...prepared.warnings.length === 0 ? {} : { warnings: prepared.warnings },
                },
              })
              return
            }
            const result = await runAdapterImage(prepared.adapter, prepared.model, prepared.params, {
              signal: controller.signal,
              onProgress: event => {
                updateStudioTask(id, {
                  phase: event.phase === 'poll' ? '生成中' : event.phase === 'download' ? '下载' : '提交',
                  message: event.message,
                  ...event.progress === undefined ? {} : { progress: event.progress },
                })
              },
            })
            const images = []
            for (const image of result.images) {
              const bytes = Buffer.from(image.b64, 'base64')
              const asset = await persistAsset(bytes, image.mime, 'image')
              images.push({
                ...asset,
                ...image.revisedPrompt === undefined ? {} : { revisedPrompt: image.revisedPrompt },
              })
            }
            updateStudioTask(id, { state: 'done', phase: '完成', message: `已完成 ${String(images.length)} 张`, progress: 100, result: { kind: 'image', images } })
          } catch (error) {
            const cancelled = controller.signal.aborted
            updateStudioTask(id, {
              state: cancelled ? 'cancelled' : 'error',
              phase: cancelled ? '已取消' : '失败',
              message: messageOf(error),
              ...cancelled ? {} : { error: { code: 'generate-failed', message: messageOf(error) } },
            })
          }
        })()
        writeJson(res, 200, { ok: true, taskId: id })
      },
    },
    // ------------------------------------------------------------ continuum
    {
      kind: 'exact',
      path: STUDIO_API.continuum,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 200, { ok: false, code: 'bad-request', message: '请求体不是合法 JSON' })
          return
        }
        const prepared = await prepareGenerate({ ...body, surface: 'video' }, await resolveAdapters())
        if ('failure' in prepared) {
          writeJson(res, 200, { ok: false, code: 'invalid', message: prepared.failure })
          return
        }
        const request = body as unknown as StudioContinuumRequest
        const segments = Number(request.segments)
        if (!Number.isFinite(segments) || segments < 1) {
          writeJson(res, 200, { ok: false, code: 'invalid', message: 'segments 必须是正整数' })
          return
        }
        const { id, controller } = createStudioTask('continuum')
        updateStudioTask(id, { state: 'running', phase: '准备', message: `准备渲染 ${String(segments)} 段` })
        void (async () => {
          try {
            // A continuation can start from a frame the user supplied, or from the
            // tail of a clip this panel already produced. The second case is the
            // common one ("make that shot longer") and it must not require the
            // browser to decode video just to hand a PNG back.
            let seedFrame = request.seedFrame
            if (seedFrame === undefined && typeof request.seedFromUrl === 'string' && request.seedFromUrl !== '') {
              const name = request.seedFromUrl.startsWith(STUDIO_API.file)
                ? request.seedFromUrl.slice(STUDIO_API.file.length + 1)
                : request.seedFromUrl.split('/').pop() ?? ''
              const filePath = resolveInside(studioOutDir(), decodeURIComponent(name))
              if (filePath === undefined) throw new Error('续时长：找不到要延续的视频文件')
              const bytes = await fs.readFile(filePath)
              seedFrame = await grabTailFrame(bytes, filePath.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4', path.join(studioOutDir(), '..', 'continuum'), { signal: controller.signal })
            }
            const result = await runContinuum({
              adapter: prepared.adapter,
              model: prepared.model,
              prompt: request.prompt,
              segments,
              seconds: prepared.params.duration ?? 5,
              ...request.promptStep === undefined ? {} : { promptStep: request.promptStep },
              ...seedFrame === undefined ? {} : { seedFrame },
              ...prepared.params.aspect === undefined ? {} : { aspect: prepared.params.aspect },
              ...prepared.params.resolution === undefined ? {} : { resolution: prepared.params.resolution },
              ...prepared.params.seed === undefined ? {} : { seed: prepared.params.seed },
              ...prepared.params.custom === undefined ? {} : { custom: prepared.params.custom },
              ...request.crossfadeMs === undefined ? {} : { crossfadeMs: request.crossfadeMs },
            }, {
              signal: controller.signal,
              onProgress: event => {
                updateStudioTask(id, { phase: event.phase === 'stitch' ? '拼接' : '渲染', message: event.message, ...event.progress === undefined ? {} : { progress: Math.round(event.progress * 100) } })
              },
            })
            const final = result.stitched ?? result.segments[result.segments.length - 1]!
            const asset = await persistAsset(final.bytes, final.mime, 'continuum')
            const kept = []
            for (const segment of result.segments) {
              const stored = await persistAsset(segment.bytes, segment.mime, `seg${String(segment.index + 1)}`)
              kept.push({ ...stored, duration: segment.seconds })
            }
            const totalSeconds = result.segments.reduce((sum, segment) => sum + segment.seconds, 0)
            updateStudioTask(id, {
              state: 'done',
              phase: '完成',
              message: `已完成 ${String(result.segments.length)} 段`,
              progress: 100,
              result: {
                kind: 'video',
                video: { ...asset, duration: result.stitched?.duration ?? totalSeconds },
                segments: kept,
                ...result.warnings.length === 0 ? {} : { warnings: result.warnings },
              },
            })
          } catch (error) {
            const cancelled = controller.signal.aborted
            updateStudioTask(id, {
              state: cancelled ? 'cancelled' : 'error',
              phase: cancelled ? '已取消' : '失败',
              message: messageOf(error),
              ...cancelled ? {} : { error: { code: 'continuum-failed', message: messageOf(error) } },
            })
          }
        })()
        writeJson(res, 200, { ok: true, taskId: id })
      },
    },
    // ----------------------------------------------------------------- poll
    {
      kind: 'prefix',
      path: STUDIO_API.task,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const id = decodeURIComponent(url.pathname.slice(STUDIO_API.task.length + 1))
        const task = readStudioTask(id)
        if (task === undefined) {
          writeJson(res, 200, { ok: false, code: 'not-found', message: '任务不存在或已过期' })
          return
        }
        writeJson(res, 200, { ok: true, task })
      },
    },
    {
      kind: 'exact',
      path: STUDIO_API.cancel,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const id = typeof body?.taskId === 'string' ? body.taskId : ''
        const cancelled = id !== '' && cancelStudioTask(id)
        writeJson(res, 200, { ok: true, cancelled })
      },
    },
    // ----------------------------------------------------------------- file
    {
      kind: 'prefix',
      path: STUDIO_API.file,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only' })
          return
        }
        if (req.method !== 'GET') {
          writeJson(res, 405, { ok: false, code: 'method', message: 'GET only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const name = decodeURIComponent(url.pathname.slice(STUDIO_API.file.length + 1))
        const filePath = resolveInside(studioOutDir(), name)
        if (filePath === undefined) {
          writeJson(res, 400, { ok: false, code: 'bad-name', message: '非法文件名' })
          return
        }
        const lower = filePath.toLowerCase()
        const mime = lower.endsWith('.webm') ? 'video/webm'
          : lower.endsWith('.mov') ? 'video/quicktime'
            : lower.endsWith('.mp4') ? 'video/mp4'
              : lower.endsWith('.jpg') ? 'image/jpeg'
                : lower.endsWith('.webp') ? 'image/webp'
                  : lower.endsWith('.gif') ? 'image/gif'
                    : lower.endsWith('.mp3') ? 'audio/mpeg'
                      : 'image/png'
        await sendFile(res, filePath, mime, typeof req.headers.range === 'string' ? req.headers.range : undefined)
      },
    },
  ]
  return routes
}
