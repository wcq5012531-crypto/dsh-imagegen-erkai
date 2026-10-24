/**
 * dsh-imagegen-studio — user-defined protocol adapters.
 *
 * The stock channel model assumes an OpenAI-compatible gateway: one endpoint
 * shape, one field vocabulary. Real gateways disagree about almost everything —
 * `size` versus `resolution` versus `aspect_ratio`, `seconds` versus `duration`,
 * `image[]` versus `input_reference`, task ids under `id` versus `data.task_id`,
 * finished URLs under `data[0].url` versus `output.video_url`. This module is the
 * description of one such protocol, plus the two pieces of machinery that make it
 * usable without writing code: `{{placeholder}}` templating and a cURL importer.
 *
 * Everything here is pure: no I/O, no settings, no network. The engine
 * (`adapter-engine.ts`) executes what this module describes.
 */

import type { StudioParamField } from './param-schema.ts'

/** Which pipeline an adapter feeds. */
export type AdapterKind = 'image' | 'video'

/** How the credential travels on the wire. */
export type AdapterAuthStyle = 'bearer' | 'header' | 'query' | 'none'

/**
 * Body field names for one gateway. Every key is optional: an absent key means
 * "this gateway does not accept that parameter", and the engine omits it rather
 * than inventing a name. Per-model overrides win over adapter-level defaults,
 * which is what lets a single gateway expose models that spell the same knob
 * differently (`nano-banana` wants `image_size`, `gpt-image-2` wants `size`).
 */
/**
 * One body field name.
 *
 * `null` is a deliberate "do not send this parameter": it beats every lower
 * layer of the field map, which is how a model that rejects `size` (or wants
 * the knob only as a query parameter) stops the engine from inventing one.
 * An absent key keeps the layer below; an empty string is ignored.
 */
export type FieldName = string | null

export interface AdapterFieldMap {
  /** Model id field. Defaults to `model`. */
  model?: FieldName
  /** Prompt field. Defaults to `prompt`. */
  prompt?: FieldName
  /** Pixel-size field, e.g. `size` with the value `1024x1024`. */
  size?: FieldName
  /** Aspect-ratio field, e.g. `aspect_ratio` with the value `16:9`. */
  aspect?: FieldName
  /** Resolution-tier field, e.g. `resolution` with the value `1080P` or `2k`. */
  resolution?: FieldName
  /** Duration field, e.g. `seconds` or `duration`. */
  duration?: FieldName
  /** Image-count field. Omit when the gateway is always 1. */
  n?: FieldName
  /** Seed field. */
  seed?: FieldName
  /** Negative-prompt field. */
  negativePrompt?: FieldName
  /** Reference-image field. Omit (`null`) for text-only models. */
  image?: FieldName
  /**
   * How reference images are encoded in the body:
   * `data-uri-array` (default, matches OpenAI `image: ["data:..."]`),
   * `base64-array`, `url-array`, `single-data-uri`,
   * `first-last-object` (keyframe models, uses `firstFrame` / `lastFrame`),
   * `multipart-file` (the engine sends multipart/form-data instead of JSON).
   */
  imageMode?: 'data-uri-array' | 'base64-array' | 'url-array' | 'single-data-uri' | 'first-last-object' | 'multipart-file'
  /** First-frame field for keyframe models. */
  firstFrame?: FieldName
  /** Last-frame field for keyframe models. */
  lastFrame?: FieldName
  /** Reference-video field (multi-reference video models). */
  refVideos?: FieldName
  /** Reference-audio field. */
  refAudios?: FieldName
  /**
   * When the size knob is expressed as a ratio but the gateway wants a pixel
   * pair, set this table: `{ '16:9': '1280x720' }`. Absent means "send the ratio".
   */
  sizeByRatio?: Record<string, string>
}

/** One model exposed by an adapter, with its own capability surface. */
export interface AdapterModelSpec {
  /** Display name used by the panel, the canvas and the Agent. */
  alias: string
  /** Upstream model id actually sent to the gateway. */
  id: string
  /** Aspect ratios this model accepts; empty means "whatever the request has". */
  aspectRatios?: string[]
  /** Resolution tiers (`480P` / `720P` / `1k` / `2k` … and any custom token). */
  resolutions?: string[]
  /** Durations in seconds, for video models. */
  durations?: number[]
  /** Reference-image cap; 0 or absent means text-only. */
  maxRefImages?: number
  /** Static extra body fields merged last (wins over anything derived). */
  extra?: Record<string, unknown>
  /** Field-name overrides for this model only. */
  fieldOverrides?: AdapterFieldMap
  /**
   * Free-form parameters this model exposes.
   *
   * This is the escape hatch that makes the adapter layer genuinely universal:
   * every declared field becomes one control in the panel and one exact wire
   * write (body / query / header), with its own type, choices, bounds and
   * vendor tokens. A field may also claim a canonical role (`size`,
   * `duration`, …) so a model that spells the knob differently still drives the
   * shared chips. Absent means "only the classic field map".
   */
  params?: StudioParamField[]
  /** Price hint shown on the confirm card, e.g. `≈0.35 元/张`. */
  priceNote?: string
}

/** Async submit → poll → result description. */
export interface AdapterPollSpec {
  /** Poll path template; `{{taskId}}` is replaced. Defaults to submit path + id. */
  path: string
  method?: 'GET' | 'POST'
  /** JSON path in the submit response holding the task id. */
  taskIdPath: string
  /** JSON path holding the status token. */
  statusPath?: string
  /** Statuses that mean "finished". Defaults to a common vocabulary. */
  doneValues?: string[]
  /** Statuses that mean "failed". */
  failedValues?: string[]
  /** JSON path holding a 0–100 progress number. */
  progressPath?: string
  /** JSON path holding an error message. */
  errorPath?: string
  intervalMs?: number
  timeoutMs?: number
}

/** How to read the finished asset out of the final response. */
export interface AdapterResultSpec {
  /** URL paths tried in order; `[]` walks arrays (`data[].url`). */
  urlPaths?: string[]
  /** Base64 paths tried when no URL matches. */
  b64Paths?: string[]
  /** Path holding the asset MIME when the response does not set one. */
  mimePath?: string
  /** Path holding a revised prompt. */
  revisedPromptPath?: string
  /** Send the auth header when downloading the result (private buckets). */
  downloadAuth?: boolean
}

/** One complete custom protocol. */
export interface AdapterProfile {
  id: string
  label: string
  kind: AdapterKind
  /** Origin only, e.g. `https://api.mmg.lat`. Paths carry the rest. */
  baseUrl: string
  auth: {
    style: AdapterAuthStyle
    /** Header name for `header` style; defaults to `Authorization`. */
    headerName?: string
    /** Query parameter name for `query` style. */
    queryName?: string
    /** The credential. Host-only: the browser receives a mask. */
    token: string
    /** Prefix for `bearer` / `header`, defaults to `Bearer ` / `''`. */
    prefix?: string
  }
  submit: {
    method: 'POST' | 'GET'
    /** Path appended to `baseUrl`, or an absolute URL. */
    path: string
    /** Body encoding. `multipart` is implied by `imageMode: multipart-file`. */
    contentType?: 'json' | 'multipart' | 'query'
    /**
     * Raw body template. Placeholders: `{{prompt}} {{model}} {{size}} {{aspect}}
     * {{resolution}} {{duration}} {{n}} {{seed}} {{negative_prompt}} {{image}}
     * {{images}} {{first_frame}} {{last_frame}}`. When present the engine renders
     * this JSON and sends it as-is, ignoring the field map except for reference
     * images (which still need binary handling).
     */
    bodyTemplate?: string
    /** Extra static headers. */
    headers?: Record<string, string>
  }
  /** Absent means the endpoint answers synchronously with the asset. */
  poll?: AdapterPollSpec
  result: AdapterResultSpec
  fields?: AdapterFieldMap
  models: AdapterModelSpec[]
  /** Free-form note shown in the editor. */
  note?: string
  /** Creation / mutation bookkeeping (ms epoch). */
  createdAt?: number
  updatedAt?: number
}

/** The token replaced by real credentials before a preview or a send. */
export const TOKEN_PLACEHOLDER = '{{token}}'

/** Statuses treated as terminal when an adapter does not say otherwise. */
export const DEFAULT_DONE_VALUES = ['succeeded', 'success', 'completed', 'complete', 'done', 'finished', 'ready', 'ready_to_download', 'SUCCEEDED', 'SUCCESS']
/** Statuses treated as failure when an adapter does not say otherwise. */
export const DEFAULT_FAILED_VALUES = ['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired', 'rejected', 'FAILED', 'ERROR']

/** Field map defaults: the OpenAI-compatible vocabulary. */
export const DEFAULT_FIELDS: {
  model: string
  prompt: string
  size: string
  aspect: string
  resolution: string
  duration: string
  n: string
  image: string
  imageMode: NonNullable<AdapterFieldMap['imageMode']>
  firstFrame: string
  lastFrame: string
} = {
  model: 'model',
  prompt: 'prompt',
  size: 'size',
  aspect: 'aspect_ratio',
  resolution: 'resolution',
  duration: 'seconds',
  n: 'n',
  image: 'image',
  imageMode: 'data-uri-array',
  firstFrame: 'first_frame',
  lastFrame: 'last_frame',
}

/** Merge the field maps in increasing priority order. */
export function resolveFields(...layers: (AdapterFieldMap | undefined)[]): AdapterFieldMap {
  const merged: AdapterFieldMap = {}
  for (const layer of layers) {
    if (layer === undefined) continue
    for (const [key, value] of Object.entries(layer)) {
      // `null` is a deliberate disable and must survive every layer below it;
      // an empty string means "not provided" and lets the next layer win.
      if (value === undefined || value === '') continue
      ;(merged as Record<string, unknown>)[key] = value
    }
  }
  return merged
}

/**
 * Read one dotted path out of a JSON value.
 *
 * Supported grammar, which covers every gateway shape seen so far:
 * - `a.b.c` — object walk
 * - `a.0.b` — numeric index
 * - `a[0].b` — bracket index
 * - `a[].b` — map over every element of `a`, returning several values
 * - `a[*].b` — same as `a[].b`
 *
 * Returns every match (empty when the path does not resolve), so callers do not
 * have to care whether the response is an object or a list of assets.
 */
export function readJsonPath(value: unknown, path: string): unknown[] {
  const tokens: (string | number)[] = []
  {
    let index = 0
    const text = path.trim()
    while (index < text.length) {
      const char = text[index]
      if (char === '.') { index += 1; continue }
      if (char === '[') {
        const close = text.indexOf(']', index)
        if (close === -1) return []
        const inner = text.slice(index + 1, close).trim()
        if (inner === '' || inner === '*') tokens.push('[]')
        else if (/^\d+$/.test(inner)) tokens.push(Number(inner))
        else if (/^'.*'$/.test(inner) || /^".*"$/.test(inner)) tokens.push(inner.slice(1, -1))
        else tokens.push(inner)
        index = close + 1
        continue
      }
      let end = index
      while (end < text.length && text[end] !== '.' && text[end] !== '[') end += 1
      const token = text.slice(index, end)
      if (token !== '') tokens.push(token)
      index = end
    }
  }
  let frontier: unknown[] = [value]
  for (const token of tokens) {
    const next: unknown[] = []
    for (const node of frontier) {
      if (token === '[]') {
        if (Array.isArray(node)) next.push(...node)
        else if (node !== null && typeof node === 'object') next.push(...Object.values(node as Record<string, unknown>))
        continue
      }
      if (node === null || node === undefined) continue
      if (typeof token === 'number') {
        if (Array.isArray(node) && token < node.length) next.push(node[token])
        continue
      }
      if (typeof node === 'object') {
        const record = node as Record<string, unknown>
        if (Object.hasOwn(record, token)) next.push(record[token])
      }
    }
    frontier = next
    if (frontier.length === 0) return []
  }
  return frontier
}

/** First non-empty string found at any of the given paths. */
export function readFirstString(value: unknown, paths: readonly string[]): string | undefined {
  for (const path of paths) {
    for (const hit of readJsonPath(value, path)) {
      if (typeof hit === 'string' && hit.trim() !== '') return hit
      if (typeof hit === 'number') return String(hit)
    }
  }
  return undefined
}

/** Every string found at the given path (used for arrays of URLs). */
export function readStringList(value: unknown, path: string): string[] {
  const out: string[] = []
  for (const hit of readJsonPath(value, path)) {
    if (typeof hit === 'string' && hit.trim() !== '') out.push(hit)
  }
  return out
}

/** Values substituted into a template. */
export interface TemplateValues {
  [key: string]: string | number | undefined
}

/**
 * Render `{{name}}` placeholders.
 *
 * A placeholder with no value renders as an empty string, and an object or array
 * value is JSON-encoded so a template can embed structures (`"refs": {{images}}`).
 * Numeric placeholders are never quoted by the renderer: the template author
 * writes the quotes when the gateway wants a string.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, name: string) => {
    const value = values[name]
    if (value === undefined || value === null) return ''
    if (typeof value === 'number') return String(value)
    return value
  })
}

/** Render then parse a JSON body template; throws a readable error on bad JSON. */
export function renderJsonTemplate(template: string, values: TemplateValues): Record<string, unknown> {
  const rendered = renderTemplate(template, values)
  try {
    const parsed: unknown = JSON.parse(rendered)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('模板必须是一个 JSON 对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`请求体模板解析失败：${message}；渲染结果：${rendered.slice(0, 400)}`)
  }
}

/** Assign a dotted or bracketed path in a plain object, creating containers. */
export function writeJsonPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(part => part !== '')
  if (parts.length === 0) return
  let node: Record<string, unknown> = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    const existing = node[key]
    if (existing === undefined || existing === null || typeof existing !== 'object') {
      const container: Record<string, unknown> = {}
      node[key] = container
      node = container
      continue
    }
    node = existing as Record<string, unknown>
  }
  node[parts[parts.length - 1]] = value
}

/* ------------------------------------------------------------------ cURL ---- */

/** One parsed cURL command. */
export interface ParsedCurl {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * Split a shell command into argv, honouring single quotes, double quotes and
 * backslash escapes. Written by hand because the plugin has no dependency budget
 * for a shell-word parser and cURL lines only ever need this much.
 */
export function splitShellWords(text: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote === "'") {
      if (char === "'") { quote = null; continue }
      current += char
      started = true
      continue
    }
    if (quote === '"') {
      if (char === '\\' && index + 1 < text.length) {
        const next = text[index + 1]
        current += next === '"' || next === '\\' ? next : `\\${next}`
        index += 1
        started = true
        continue
      }
      if (char === '"') { quote = null; continue }
      current += char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < text.length) {
      const next = text[index + 1]
      // A backslash before a newline is a shell line continuation.
      if (next === '\n') { index += 1; continue }
      if (next === '\r') { index += 1; if (text[index + 1] === '\n') index += 1; continue }
      current += next
      index += 1
      started = true
      continue
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue }
    if (/\s/.test(char)) {
      if (started || current !== '') { words.push(current); current = ''; started = false }
      continue
    }
    current += char
    started = true
  }
  if (started || current !== '') words.push(current)
  return words
}

/** Parse a copy-pasted cURL command (Chrome / Postman / docs style). */
export function parseCurl(command: string): ParsedCurl {
  const words = splitShellWords(command.replace(/\\\r?\n/g, ' ').trim())
  if (words.length === 0) throw new Error('空的 cURL 命令')
  if (!/curl(\.exe)?$/i.test(words[0]) && !/^curl(\.exe)?$/i.test(words[0].replace(/^["']|["']$/g, ''))) {
    // Tolerate a pasted line that starts with a shell prompt or a proxy prefix.
    if (!words.some(word => /curl(\.exe)?$/i.test(word))) throw new Error('不是一条 cURL 命令')
  }
  let url = ''
  let method = ''
  const headers: Record<string, string> = {}
  let body: string | undefined
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]
    const take = (): string => {
      index += 1
      const value = words[index]
      if (value === undefined) throw new Error(`参数 ${word} 缺少值`)
      return value
    }
    if (word === '-H' || word === '--header') {
      const raw = take()
      const colon = raw.indexOf(':')
      if (colon > 0) headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim()
      continue
    }
    if (word === '-X' || word === '--request') { method = take().toUpperCase(); continue }
    if (word === '-d' || word === '--data' || word === '--data-raw' || word === '--data-binary' || word === '--data-urlencode') {
      body = take()
      continue
    }
    if (word === '-u' || word === '--user' || word === '-o' || word === '--output' || word === '-F' || word === '--form' || word === '--compressed' || word === '-s' || word === '--silent' || word === '-k' || word === '--insecure') {
      if (word !== '--compressed' && word !== '-s' && word !== '--silent' && word !== '-k' && word !== '--insecure') take()
      continue
    }
    if (word === '-A' || word === '--user-agent' || word === '-e' || word === '--referer') { take(); continue }
    if (word === '--url') { url = take(); continue }
    if (word.startsWith('-')) continue
    if (url === '') url = word
  }
  if (url === '') throw new Error('cURL 中没有找到 URL')
  return { url, method: method === '' ? (body === undefined ? 'GET' : 'POST') : method, headers, body }
}

/** What an import produced, plus the guesses it had to make. */
export interface CurlImportResult {
  adapter: AdapterProfile
  /** Human-readable notes about what was inferred and what still needs a look. */
  notes: string[]
}

/** Keys whose values are replaced by placeholders when a cURL body is imported. */
const BODY_PLACEHOLDERS: { keys: readonly string[]; placeholder: string }[] = [
  { keys: ['prompt', 'text', 'input', 'description'], placeholder: '{{prompt}}' },
  { keys: ['model', 'model_id', 'modelId'], placeholder: '{{model}}' },
  { keys: ['size', 'image_size', 'dimensions'], placeholder: '{{size}}' },
  { keys: ['aspect_ratio', 'ratio', 'aspect'], placeholder: '{{aspect}}' },
  { keys: ['resolution', 'quality', 'tier'], placeholder: '{{resolution}}' },
  { keys: ['seconds', 'duration', 'length', 'video_length'], placeholder: '{{duration}}' },
  { keys: ['n', 'num_images', 'count', 'batch_size'], placeholder: '{{n}}' },
  { keys: ['seed', 'random_seed'], placeholder: '{{seed}}' },
  { keys: ['negative_prompt', 'negativePrompt'], placeholder: '{{negative_prompt}}' },
  { keys: ['image', 'images', 'input_reference', 'reference_images', 'first_frame', 'init_image'], placeholder: '{{images}}' },
]

/**
 * Turn a pasted cURL into an adapter draft.
 *
 * The parse is deliberately conservative: it keeps every header and the whole
 * body, replaces only the values it recognises, and reports everything it could
 * not decide as a note. A wrong guess is visible in the dry-run preview, which
 * is why a guess is acceptable here at all.
 */
export function importCurl(command: string, options?: { kind?: AdapterKind; label?: string }): CurlImportResult {
  const parsed = parseCurl(command)
  const notes: string[] = []
  let url: URL
  try {
    url = new URL(parsed.url)
  } catch {
    throw new Error(`URL 无法解析：${parsed.url}`)
  }

  // Credential: Authorization / x-api-key style headers, or a query parameter
  // that looks like a key. Never keep the token in the header map as well.
  const headers: Record<string, string> = {}
  let token = ''
  let style: AdapterAuthStyle = 'none'
  let headerName = 'Authorization'
  let prefix = 'Bearer '
  let queryName = ''
  for (const [name, value] of Object.entries(parsed.headers)) {
    const lower = name.toLowerCase()
    if (lower === 'authorization') {
      style = 'bearer'
      headerName = name
      const match = /^(\S+)\s+(.*)$/.exec(value)
      token = match === null ? value : match[2]
      prefix = match === null ? '' : `${match[1]} `
      continue
    }
    if (lower === 'x-api-key' || lower === 'api-key' || lower === 'apikey' || lower === 'x-goog-api-key') {
      style = 'header'
      headerName = name
      token = value
      prefix = ''
      continue
    }
    headers[name] = value
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(api[-_]?key|key|token|access_token)$/i.test(key) && token === '') {
      style = 'query'
      queryName = key
      token = url.searchParams.get(key) ?? ''
      url.searchParams.delete(key)
    }
  }
  if (token === '') notes.push('没有在 cURL 里找到凭据（Authorization / x-api-key / key 查询参数）；请在编辑器里补填 Key。')

  // Body template: replace recognised scalar values, keep everything else.
  let bodyTemplate: string | undefined
  let templateModelId = ''
  let contentType: 'json' | 'multipart' | 'query' = parsed.body === undefined ? 'query' : 'json'
  if (parsed.body !== undefined) {
    const trimmed = parsed.body.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsedBody = JSON.parse(trimmed) as unknown
        if (parsedBody !== null && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
          const record = { ...(parsedBody as Record<string, unknown>) }
          // Read the model id BEFORE templating. Once `model` becomes
          // `{{model}}` the literal the user pasted is gone, and that literal is
          // exactly what a one-click import is supposed to capture.
          if (typeof record.model === 'string' && record.model.trim() !== '') templateModelId = record.model.trim()
          for (const { keys, placeholder } of BODY_PLACEHOLDERS) {
            for (const key of keys) {
              if (!Object.hasOwn(record, key)) continue
              record[key] = placeholder
            }
          }
          bodyTemplate = JSON.stringify(record, null, 2)
        } else {
          bodyTemplate = trimmed
          notes.push('请求体不是 JSON 对象，已原样保留为模板。')
        }
      } catch {
        bodyTemplate = trimmed
        notes.push('请求体不是合法 JSON，已原样保留为模板；请手工把值改成 {{prompt}} 等占位符。')
      }
    } else {
      notes.push('请求体看起来是表单（x-www-form-urlencoded）；已原样保留，请确认 contentType。')
      bodyTemplate = trimmed
      contentType = 'query'
    }
  }

  // Kind guess: a video-ish path or duration field means video.
  const kind: AdapterKind = options?.kind
    ?? (/video/i.test(url.pathname) ? 'video'
      : /image|draw|pic/i.test(url.pathname) ? 'image'
        : bodyTemplate !== undefined && /\{\{duration\}\}/.test(bodyTemplate) ? 'video' : 'image')
  if (options?.kind === undefined) notes.push(`按路径推断为 ${kind === 'video' ? '视频' : '图片'} 适配器，可在编辑器里切换。`)

  let body: Record<string, unknown> | undefined
  if (bodyTemplate !== undefined && bodyTemplate.trim().startsWith('{')) {
    try { body = JSON.parse(bodyTemplate) as Record<string, unknown> } catch { body = undefined }
  }
  const modelId = typeof body?.model === 'string' && body.model !== '{{model}}' ? body.model : templateModelId

  const adapter: AdapterProfile = {
    id: `adapter-${Math.random().toString(36).slice(2, 10)}`,
    label: options?.label ?? `${url.hostname}${url.pathname}`,
    kind,
    baseUrl: url.origin,
    auth: {
      style,
      ...style === 'header' ? { headerName } : {},
      ...style === 'query' ? { queryName } : {},
      token,
      prefix,
    },
    submit: {
      method: (parsed.method === 'GET' ? 'GET' : 'POST'),
      path: `${url.pathname}${url.search}`,
      contentType,
      ...bodyTemplate === undefined ? {} : { bodyTemplate },
      ...Object.keys(headers).length === 0 ? {} : { headers },
    },
    result: {
      urlPaths: ['data[].url', 'data[].b64_json', 'video_url', 'url', 'output.url', 'output.video_url', 'result.url', 'data.url'],
      b64Paths: ['data[].b64_json', 'b64_json', 'output.b64_json'],
      revisedPromptPath: 'data[].revised_prompt',
    },
    models: [{
      alias: modelId === '' ? 'default' : modelId,
      id: modelId === '' ? '{{model}}' : modelId,
      maxRefImages: /\{\{images\}\}/.test(bodyTemplate ?? '') ? 2 : 0,
    }],
    note: `由 cURL 导入：${parsed.method} ${url.pathname}`,
  }
  if (modelId === '') notes.push('请求体里没有具体的 model 值；请在“模型”页填入网关的 model id。')

  // Task-id shape: if the body/scope looks like an async video submit, seed a
  // poll config so the user only has to confirm the path.
  if (kind === 'video') {
    adapter.poll = {
      path: `${url.pathname.replace(/\/+$/, '')}/{{taskId}}`,
      taskIdPath: 'id',
      statusPath: 'status',
      intervalMs: 3000,
      timeoutMs: 15 * 60_000,
    }
    notes.push('已按视频异步协议预填轮询路径（taskIdPath=id）；若网关用 data.task_id，请在“轮询”页改。')
  }
  return { adapter, notes }
}

/** Mask a credential for display. */
export function maskToken(token: string): string {
  const trimmed = token.trim()
  if (trimmed === '') return ''
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`
  return `${trimmed.slice(0, 4)}***${trimmed.slice(-4)}`
}

/**
 * Shape an adapter for the browser: the credential is replaced by a masked
 * string, exactly like the built-in channel view does for `channelSecrets`.
 */
export function viewAdapter(adapter: AdapterProfile): AdapterProfile {
  return { ...adapter, auth: { ...adapter.auth, token: maskToken(adapter.auth.token) } }
}
