/**
 * Studio adapter override persistence.
 *
 * The channels in the settings document own the endpoint, the key and the model
 * catalogue. What this file stores is the part a channel row cannot describe:
 * per-model parameter lists, ratios, reference limits, and the wire contract of
 * that channel's gateway (submit path, poll spec, result paths, field names).
 * `channel-adapters.ts` joins the two at read time, so this store never carries
 * a credential and never decides which models exist — deleting a model in the
 * settings page removes it from the studio as well.
 *
 * Writes are atomic (tmp + rename) because the drawer saves in batches and a
 * torn file would look like "all my parameters vanished".
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { imageDataRoot } from '../image-storage-path.ts'
import {
  type AdapterFieldMap,
  type AdapterKind,
  type AdapterModelSpec,
  type AdapterProfile,
} from './adapter-spec.ts'
import { normalizeParamFields } from './param-schema.ts'

/** Store schema version; bumped only on an incompatible reshape. */
const STORE_VERSION = 1

/** Largest accepted profile file, which also bounds a hostile local write. */
const MAX_STORE_BYTES = 8 * 1024 * 1024

/** Where this module keeps its state. */
export function studioRoot(): string {
  return path.join(imageDataRoot(), 'studio')
}

/** Where generated studio assets are written before being served. */
export function studioOutDir(): string {
  return path.join(studioRoot(), 'out')
}

/** The adapter store file. */
function storePath(): string {
  return path.join(studioRoot(), 'adapters.json')
}

/** Whole-file payload. */
interface StudioStoreFile {
  version: number
  adapters: AdapterProfile[]
}

/** What the browser is allowed to see: the token is reduced to a mask. */
export interface MaskedAdapterProfile extends Omit<AdapterProfile, 'auth'> {
  auth: Omit<AdapterProfile['auth'], 'token'> & { masked: string; hasToken: boolean }
}

/**
 * Reduce a credential to something a screenshot can survive.
 * @param token - the real credential.
 * @returns a mask that reveals only whether one is set and its last 4 chars.
 */
export function maskToken(token: string): string {
  const trimmed = token.trim()
  if (trimmed === '') return ''
  const tail = trimmed.slice(-4)
  return `••••${tail}`
}

/**
 * Strip the credential before the profile crosses into the browser.
 * @param profile - stored profile.
 * @returns the same profile with the token masked.
 */
export function maskProfile(profile: AdapterProfile): MaskedAdapterProfile {
  const { auth, ...rest } = profile
  const { token, ...authRest } = auth
  return { ...rest, auth: { ...authRest, masked: maskToken(token), hasToken: token.trim() !== '' } }
}

/** Cap on a single string field, to keep a pasted blob from bloating the file. */
function clampString(value: unknown, max = 4096): string {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

/** Read one optional string field, defaulting to ''. */
function optionalString(value: unknown, max = 4096): string | undefined {
  const text = clampString(value, max).trim()
  return text === '' ? undefined : text
}

/** Keep only string entries of a list, trimmed, bounded. */
function stringList(value: unknown, max = 64): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) {
    const text = typeof entry === 'string' ? entry.trim() : typeof entry === 'number' ? String(entry) : ''
    if (text !== '' && !out.includes(text)) out.push(text.slice(0, 128))
    if (out.length >= max) break
  }
  return out.length === 0 ? undefined : out
}

/** Keep only finite positive integers from a list (durations). */
function numberList(value: unknown, max = 64): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: number[] = []
  for (const entry of value) {
    const num = typeof entry === 'number' ? entry : Number(entry)
    if (Number.isFinite(num) && num > 0 && !out.includes(num)) out.push(num)
    if (out.length >= max) break
  }
  return out.length === 0 ? undefined : out
}

/** Sanitize a field map: unknown keys dropped, empty strings dropped. */
function normalizeFields(raw: unknown): AdapterFieldMap | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const input = raw as Record<string, unknown>
  const out: AdapterFieldMap = {}
  for (const key of ['model', 'prompt', 'size', 'aspect', 'resolution', 'duration', 'n', 'seed', 'negativePrompt', 'image', 'firstFrame', 'lastFrame', 'refVideos', 'refAudios'] as const) {
    // `null` survives as "never send this parameter"; anything else is a name.
    if (input[key] === null) {
      out[key] = null
      continue
    }
    const text = optionalString(input[key], 128)
    if (text !== undefined) out[key] = text
  }
  const mode = input.imageMode
  if (mode === 'data-uri-array' || mode === 'base64-array' || mode === 'url-array' || mode === 'single-data-uri' || mode === 'first-last-object' || mode === 'multipart-file') {
    out.imageMode = mode
  }
  if (input.sizeByRatio !== null && typeof input.sizeByRatio === 'object') {
    const table: Record<string, string> = {}
    for (const [ratio, size] of Object.entries(input.sizeByRatio as Record<string, unknown>)) {
      const text = optionalString(size, 64)
      if (text !== undefined) table[clampString(ratio, 32)] = text
    }
    if (Object.keys(table).length > 0) out.sizeByRatio = table
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Sanitize one model spec.
 * @param raw - untrusted input.
 * @param index - position, used to synthesise a missing alias/id.
 * @returns a model spec, or undefined when nothing usable is present.
 */
function normalizeModel(raw: unknown, index: number): AdapterModelSpec | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const input = raw as Record<string, unknown>
  const id = clampString(input.id, 256).trim()
  const alias = clampString(input.alias, 256).trim()
  if (id === '' && alias === '') return undefined
  const out: AdapterModelSpec = {
    alias: alias === '' ? id : alias,
    id: id === '' ? alias : id,
  }
  const ratios = stringList(input.aspectRatios)
  if (ratios !== undefined) out.aspectRatios = ratios
  const resolutions = stringList(input.resolutions)
  if (resolutions !== undefined) out.resolutions = resolutions
  const durations = numberList(input.durations)
  if (durations !== undefined) out.durations = durations
  if (typeof input.maxRefImages === 'number' && Number.isFinite(input.maxRefImages) && input.maxRefImages >= 0) {
    out.maxRefImages = Math.min(16, Math.floor(input.maxRefImages))
  }
  if (input.extra !== null && typeof input.extra === 'object' && !Array.isArray(input.extra)) {
    out.extra = input.extra as Record<string, unknown>
  }
  const fields = normalizeFields(input.fieldOverrides)
  if (fields !== undefined) out.fieldOverrides = fields
  const params = normalizeParamFields(input.params)
  if (params.length > 0) out.params = params
  const priceNote = optionalString(input.priceNote, 128)
  if (priceNote !== undefined) out.priceNote = priceNote
  return { ...out, ...index < 0 ? {} : {} }
}

/**
 * Sanitize one whole profile.
 * @param raw - untrusted input (store file, or a request body).
 * @param existing - the profile being replaced, used to keep an unsent token.
 * @returns the profile plus warnings about anything that had to be dropped.
 */
export function normalizeProfile(
  raw: unknown,
  existing?: AdapterProfile,
): { profile?: AdapterProfile; warnings: string[] } {
  const warnings: string[] = []
  if (raw === null || typeof raw !== 'object') return { warnings: ['配置不是一个对象'] }
  const input = raw as Record<string, unknown>

  const kind: AdapterKind = input.kind === 'video' ? 'video' : 'image'
  const label = clampString(input.label, 120).trim() || (kind === 'video' ? '未命名视频通道' : '未命名图片通道')
  const baseUrl = clampString(input.baseUrl, 512).trim()
  if (baseUrl === '') return { warnings: ['缺少 API 地址'] }
  if (!/^https?:\/\//i.test(baseUrl)) return { warnings: ['API 地址必须以 http:// 或 https:// 开头'] }

  const authInput = input.auth !== null && typeof input.auth === 'object' ? input.auth as Record<string, unknown> : {}
  const style = authInput.style === 'header' || authInput.style === 'query' || authInput.style === 'none' ? authInput.style : 'bearer'
  // An empty token in the request means "keep the stored one": the browser only
  // ever holds a mask, so a save round-trip must not erase the credential.
  const sentToken = clampString(authInput.token, 8192).trim()
  const token = sentToken !== '' ? sentToken : existing?.auth.token ?? ''
  if (style !== 'none' && token === '') warnings.push('未填写密钥：该通道在填好密钥前无法调用')

  const submitInput = input.submit !== null && typeof input.submit === 'object' ? input.submit as Record<string, unknown> : {}
  const submitMethod = submitInput.method === 'GET' ? 'GET' : 'POST'
  const submitPath = clampString(submitInput.path, 1024).trim() || (kind === 'video' ? '/v1/videos' : '/v1/images/generations')
  const contentType = submitInput.contentType === 'multipart' || submitInput.contentType === 'query' ? submitInput.contentType : 'json'
  const headers: Record<string, string> = {}
  if (submitInput.headers !== null && typeof submitInput.headers === 'object') {
    for (const [name, value] of Object.entries(submitInput.headers as Record<string, unknown>)) {
      const text = optionalString(value, 1024)
      if (text !== undefined) headers[clampString(name, 128)] = text
    }
  }
  const bodyTemplate = optionalString(submitInput.bodyTemplate, 16_384)

  const pollInput = input.poll !== null && typeof input.poll === 'object' ? input.poll as Record<string, unknown> : undefined
  const pollPath = pollInput === undefined ? '' : clampString(pollInput.path, 1024).trim()
  let poll: AdapterProfile['poll']
  if (pollInput !== undefined && pollPath !== '') {
    poll = {
      path: pollPath,
      ...pollInput.method === 'POST' ? { method: 'POST' as const } : {},
      taskIdPath: clampString(pollInput.taskIdPath, 256).trim() || 'id',
      ...optionalString(pollInput.statusPath, 256) === undefined ? {} : { statusPath: clampString(pollInput.statusPath, 256) },
      ...stringList(pollInput.doneValues) === undefined ? {} : { doneValues: stringList(pollInput.doneValues)! },
      ...stringList(pollInput.failedValues) === undefined ? {} : { failedValues: stringList(pollInput.failedValues)! },
      ...optionalString(pollInput.progressPath, 256) === undefined ? {} : { progressPath: clampString(pollInput.progressPath, 256) },
      ...optionalString(pollInput.errorPath, 256) === undefined ? {} : { errorPath: clampString(pollInput.errorPath, 256) },
      ...typeof pollInput.intervalMs === 'number' && pollInput.intervalMs >= 500 ? { intervalMs: Math.min(60_000, pollInput.intervalMs) } : {},
      ...typeof pollInput.timeoutMs === 'number' && pollInput.timeoutMs >= 1000 ? { timeoutMs: Math.min(3_600_000, pollInput.timeoutMs) } : {},
    }
  }

  const resultInput = input.result !== null && typeof input.result === 'object' ? input.result as Record<string, unknown> : {}
  const urlPaths = stringList(resultInput.urlPaths, 16)
  const b64Paths = stringList(resultInput.b64Paths, 16)
  if (urlPaths === undefined && b64Paths === undefined) {
    warnings.push('未配置结果字段路径：默认按常见字段（data[].url / url / video_url …）自动探测')
  }

  const modelsRaw = Array.isArray(input.models) ? input.models : []
  const models: AdapterModelSpec[] = []
  for (const [index, entry] of modelsRaw.entries()) {
    const model = normalizeModel(entry, index)
    if (model === undefined) {
      warnings.push(`第 ${index + 1} 个模型缺少 id，已跳过`)
      continue
    }
    models.push(model)
  }
  if (models.length === 0) warnings.push('该通道还没有模型：先「发现模型」或手填一个')

  const now = Date.now()
  const profile: AdapterProfile = {
    id: clampString(input.id, 64).trim() || `adapter-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    label,
    kind,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    auth: {
      style,
      ...optionalString(authInput.headerName, 128) === undefined ? {} : { headerName: clampString(authInput.headerName, 128) },
      ...optionalString(authInput.queryName, 128) === undefined ? {} : { queryName: clampString(authInput.queryName, 128) },
      token,
      ...optionalString(authInput.prefix, 64) === undefined ? {} : { prefix: clampString(authInput.prefix, 64) },
    },
    submit: {
      method: submitMethod,
      path: submitPath,
      contentType,
      ...Object.keys(headers).length === 0 ? {} : { headers },
      ...bodyTemplate === undefined ? {} : { bodyTemplate },
    },
    ...poll === undefined ? {} : { poll },
    result: {
      ...urlPaths === undefined ? {} : { urlPaths },
      ...b64Paths === undefined ? {} : { b64Paths },
      ...optionalString(resultInput.mimePath, 256) === undefined ? {} : { mimePath: clampString(resultInput.mimePath, 256) },
      ...optionalString(resultInput.revisedPromptPath, 256) === undefined ? {} : { revisedPromptPath: clampString(resultInput.revisedPromptPath, 256) },
      ...resultInput.downloadAuth === true ? { downloadAuth: true } : {},
    },
    ...normalizeFields(input.fields) === undefined ? {} : { fields: normalizeFields(input.fields)! },
    models,
    ...optionalString(input.note, 2048) === undefined ? {} : { note: clampString(input.note, 2048) },
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : existing?.createdAt ?? now,
    updatedAt: now,
  }
  return { profile, warnings }
}

/** Read the store file, tolerating a missing or corrupt file. */
export async function readAdapters(): Promise<AdapterProfile[]> {
  try {
    const stat = await fs.stat(storePath())
    if (stat.size > MAX_STORE_BYTES) return []
    const raw = await fs.readFile(storePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StudioStoreFile>
    if (!Array.isArray(parsed.adapters)) return []
    const out: AdapterProfile[] = []
    for (const entry of parsed.adapters) {
      const { profile } = normalizeProfile(entry)
      if (profile !== undefined) out.push(profile)
    }
    return out
  } catch {
    return []
  }
}

/** Replace the whole list, atomically. */
export async function writeAdapters(adapters: readonly AdapterProfile[]): Promise<void> {
  await fs.mkdir(studioRoot(), { recursive: true })
  const target = storePath()
  const temp = `${target}.${process.pid.toString(36)}.tmp`
  const payload: StudioStoreFile = { version: STORE_VERSION, adapters: [...adapters] }
  await fs.writeFile(temp, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(temp, target)
}

/**
 * Insert or replace one profile.
 *
 * The credential belongs to the channel row, never to this record, so a caller
 * writing on the channel's behalf passes `forgetToken`: a key stored by an
 * older build is then dropped instead of silently inherited.
 * @param raw - untrusted input from the panel.
 * @param options - `forgetToken` clears the stored key for this id.
 * @returns the saved profile, masked for the browser, plus warnings.
 */
export async function saveAdapter(
  raw: unknown,
  options: { forgetToken?: boolean } = {},
): Promise<{ profile?: MaskedAdapterProfile; warnings: string[] }> {
  const list = await readAdapters()
  const id = raw !== null && typeof raw === 'object' && typeof (raw as Record<string, unknown>).id === 'string'
    ? (raw as Record<string, string>).id
    : ''
  const found = list.find(entry => entry.id === id)
  const existing = found === undefined || options.forgetToken !== true
    ? found
    : { ...found, auth: { ...found.auth, token: '' } }
  const { profile, warnings } = normalizeProfile(raw, existing)
  if (profile === undefined) return { warnings }
  const next = found === undefined ? [...list, profile] : list.map(entry => entry.id === profile.id ? profile : entry)
  await writeAdapters(next)
  return { profile: maskProfile(profile), warnings }
}

/**
 * Delete one profile by id.
 * @param id - profile id.
 * @returns true when something was removed.
 */
export async function removeAdapter(id: string): Promise<boolean> {
  const list = await readAdapters()
  const next = list.filter(entry => entry.id !== id)
  if (next.length === list.length) return false
  await writeAdapters(next)
  return true
}

/*
 * The first-run seeds (`defaultAdapters`) and `ensureAdapters` used to live
 * here. They were removed on purpose: a seeded store made the settings page
 * show two "channels" the user had never configured, with 21 hard-coded models
 * that belonged to no endpoint. The channel rows are the only source of
 * channels now; this file is purely their override layer.
 */

