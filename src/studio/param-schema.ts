/**
 * Free-form parameter schema — the "wire anything" layer of the adapter.
 *
 * {@link AdapterFieldMap} covers only the knobs every gateway happens to share:
 * prompt, model, size, aspect, duration. Real providers do not stop there.
 * `guidance_scale`, `sample_steps`, `watermark`, `mode`/`style` enums, an
 * `image_size` that takes the vendor's own tokens, a clip length expressed in
 * frames, a knob that must travel in the query string or in a header — none of
 * those fit a fixed field map, and all of them used to require a code change.
 *
 * {@link StudioParamField} is that missing surface. One declared field becomes
 * one control in the panel, one validated value, and one exact wire write. A
 * field can also claim a canonical {@link StudioParamRole} (`size`, `duration`,
 * …), which is how a model that spells the size knob `image_size` still drives
 * the same panel chip as every other model — the schema decides the wire, the
 * role decides the meaning.
 *
 * Everything here is pure: normalization, filtering, coercion and wire
 * encoding. The sender stays in `adapter-engine.ts`, so this module can be
 * tested from Node without a fetch stub.
 */

/** Control rendered for one declared parameter. */
export type StudioParamKind = 'enum' | 'multi' | 'number' | 'boolean' | 'string' | 'longtext' | 'json'

/** The surface a field belongs to. */
export type StudioParamSurface = 'image' | 'edit' | 'video'

/**
 * Canonical meaning of a field.
 *
 * `custom` (the default) means "send this and nothing else". Every other role
 * also fills the engine's canonical slot, so the field flows through the same
 * size / duration / aspect plumbing the built-in models use.
 */
export type StudioParamRole =
  | 'custom'
  | 'model'
  | 'prompt'
  | 'size'
  | 'aspect'
  | 'resolution'
  | 'duration'
  | 'n'
  | 'seed'
  | 'negativePrompt'

/** One choice of an `enum` / `multi` field. */
export interface StudioParamOption {
  /** Value stored in the request state and compared for selection. */
  value: string | number | boolean
  /** Label shown in the panel; defaults to `String(value)`. */
  label?: string
  /**
   * Exact token sent upstream. Defaults to `value`, and exists for the cases
   * where the panel label and the wire token differ (`1080P` shown, `1080p`
   * sent) or where the token is not a scalar at all (an object, an array).
   */
  wire?: unknown
  /**
   * Extra body fields this choice implies, merged when the choice is active.
   * This is how a size tier sets a hidden width/height pair.
   */
  patch?: Record<string, unknown>
  /** Free-form hint under the option in the editor. */
  hint?: string
}

/** Where a value is written on the wire. */
export type StudioParamTarget = 'body' | 'query' | 'header'

/** One declared parameter of one model. */
export interface StudioParamField {
  /** Stable key: the request-state key and the editor row id. */
  key: string
  /** Control kind. */
  kind: StudioParamKind
  /** Panel label; defaults to the key. */
  label?: string
  /** Canonical meaning, defaulting to `custom`. */
  role?: StudioParamRole
  /** Wire destination, defaulting to `body`. */
  target?: StudioParamTarget
  /** Wire name when it differs from `key` (e.g. `image_size`). */
  name?: string
  /** Choices for `enum` / `multi`. */
  options?: StudioParamOption[]
  /** Initial value. Absent means "empty" (the field is not sent). */
  default?: unknown
  /** Numeric bounds, applied on coercion and in the editor. */
  min?: number
  max?: number
  step?: number
  /** Unit label for numbers (`s`, `px`, `%`). */
  unit?: string
  /** Placeholder for text-ish kinds. */
  placeholder?: string
  /** Help text under the control. */
  help?: string
  /** Surfaces this field appears on; absent means every surface. */
  surfaces?: StudioParamSurface[]
  /**
   * Only offer the field while references of this type are attached. A
   * `mode: 'image-to-video'` knob is noise on a text-to-video request.
   */
  requires?: 'image' | 'video' | 'audio'
  /** Never send this field when its value equals the field's default. */
  omitWhenDefault?: boolean
  /** Drop the field when the value is empty (default for optional kinds). */
  omitWhenEmpty?: boolean
  /**
   * Encode before writing. `csv` joins arrays with commas, `json` stringifies,
   * `bool01` writes 1/0 (some gateways refuse real booleans).
   */
  encode?: 'raw' | 'string' | 'number' | 'boolean' | 'csv' | 'json' | 'bool01'
  /** Send even when the value is empty (empty string / 0 / false are meaningful). */
  always?: boolean
}

/** Resolved wire extras produced from one parameter state. */
export interface StudioWireExtras {
  body?: Record<string, unknown>
  query?: Record<string, string>
  headers?: Record<string, string>
}

/** Canonical slots a role can fill, in engine terms. */
export interface StudioRoleValues {
  model?: string
  prompt?: string
  size?: string
  aspect?: string
  resolution?: string
  duration?: number
  n?: number
  seed?: number
  negativePrompt?: string
}

/** Everything one parameter state resolves to. */
export interface StudioResolvedParams {
  /** Normalized values (after coercion and defaults). */
  values: Record<string, unknown>
  /** Canonical slots for the engine. */
  roles: StudioRoleValues
  /** Wire extras for the engine. */
  extras: StudioWireExtras
  /** Values that were rejected, with a human-readable reason. */
  warnings: string[]
}

const KINDS = new Set<StudioParamKind>(['enum', 'multi', 'number', 'boolean', 'string', 'longtext', 'json'])
const ROLES = new Set<StudioParamRole>(['custom', 'model', 'prompt', 'size', 'aspect', 'resolution', 'duration', 'n', 'seed', 'negativePrompt'])
const TARGETS = new Set<StudioParamTarget>(['body', 'query', 'header'])
const SURFACES = new Set<StudioParamSurface>(['image', 'edit', 'video'])
const ENCODES = new Set(['raw', 'string', 'number', 'boolean', 'csv', 'json', 'bool01'])

/** Guard one unknown option. */
function normalizeOption(raw: unknown): StudioParamOption | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const value = record.value
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined
  const patch = record.patch !== null && typeof record.patch === 'object' && !Array.isArray(record.patch)
    ? record.patch as Record<string, unknown>
    : undefined
  return {
    value,
    ...typeof record.label === 'string' && record.label.trim() !== '' ? { label: record.label } : {},
    ...record.wire === undefined ? {} : { wire: record.wire },
    ...patch === undefined ? {} : { patch },
    ...typeof record.hint === 'string' && record.hint.trim() !== '' ? { hint: record.hint } : {},
  }
}

/** Guard one unknown field, tolerating any extra keys. */
function normalizeField(raw: unknown, index: number): StudioParamField | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  if (key === '') return undefined
  const kind = typeof record.kind === 'string' && KINDS.has(record.kind as StudioParamKind)
    ? record.kind as StudioParamKind
    : 'string'
  const options = Array.isArray(record.options)
    ? record.options.flatMap(option => {
      const parsed = normalizeOption(option)
      return parsed === undefined ? [] : [parsed]
    })
    : undefined
  const surfaces = Array.isArray(record.surfaces)
    ? record.surfaces.filter((item): item is StudioParamSurface => typeof item === 'string' && SURFACES.has(item as StudioParamSurface))
    : undefined
  const role = typeof record.role === 'string' && ROLES.has(record.role as StudioParamRole)
    ? record.role as StudioParamRole
    : 'custom'
  const target = typeof record.target === 'string' && TARGETS.has(record.target as StudioParamTarget)
    ? record.target as StudioParamTarget
    : 'body'
  const encode = typeof record.encode === 'string' && ENCODES.has(record.encode)
    ? record.encode as StudioParamField['encode']
    : undefined
  const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return {
    key,
    kind,
    role,
    target,
    ...typeof record.label === 'string' && record.label.trim() !== '' ? { label: record.label } : {},
    ...typeof record.name === 'string' && record.name.trim() !== '' ? { name: record.name } : {},
    ...options === undefined || options.length === 0 ? {} : { options },
    ...record.default === undefined ? {} : { default: record.default },
    ...numeric(record.min) === undefined ? {} : { min: numeric(record.min) },
    ...numeric(record.max) === undefined ? {} : { max: numeric(record.max) },
    ...numeric(record.step) === undefined ? {} : { step: numeric(record.step) },
    ...typeof record.unit === 'string' && record.unit.trim() !== '' ? { unit: record.unit } : {},
    ...typeof record.placeholder === 'string' && record.placeholder.trim() !== '' ? { placeholder: record.placeholder } : {},
    ...typeof record.help === 'string' && record.help.trim() !== '' ? { help: record.help } : {},
    ...surfaces === undefined || surfaces.length === 0 ? {} : { surfaces },
    ...record.requires === 'image' || record.requires === 'video' || record.requires === 'audio' ? { requires: record.requires } : {},
    ...record.omitWhenDefault === true ? { omitWhenDefault: true } : {},
    ...record.omitWhenEmpty === true ? { omitWhenEmpty: true } : {},
    ...encode === undefined ? {} : { encode },
    ...record.always === true ? { always: true } : {},
    ...index < 0 ? {} : {},
  }
}

/**
 * Normalize a declared parameter list.
 *
 * Duplicate keys are collapsed on the first occurrence: two controls writing
 * the same body key would silently fight, and the editor cannot show which one
 * won.
 * @param raw - untrusted value (settings document, HTTP body, preset).
 * @returns the usable fields, in declaration order.
 */
export function normalizeParamFields(raw: unknown): StudioParamField[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: StudioParamField[] = []
  for (const [index, item] of raw.entries()) {
    const field = normalizeField(item, index)
    if (field === undefined || seen.has(field.key)) continue
    seen.add(field.key)
    out.push(field)
  }
  return out
}

/** Media attached to one request, used for `requires` filtering. */
export interface StudioParamMedia {
  images?: number
  videos?: number
  audios?: number
}

/**
 * Fields a given surface should render.
 * @param fields - declared fields.
 * @param surface - image / edit / video.
 * @param media - attached reference counts.
 * @returns the fields to show, in declaration order.
 */
export function fieldsForSurface(
  fields: readonly StudioParamField[],
  surface: StudioParamSurface,
  media: StudioParamMedia = {},
): StudioParamField[] {
  return fields.filter(field => {
    if (field.surfaces !== undefined && !field.surfaces.includes(surface)) return false
    if (field.requires === 'image' && (media.images ?? 0) === 0) return false
    if (field.requires === 'video' && (media.videos ?? 0) === 0) return false
    if (field.requires === 'audio' && (media.audios ?? 0) === 0) return false
    return true
  })
}

/** Human label for one field. */
export function paramLabel(field: StudioParamField): string {
  return field.label ?? field.key
}

/** Label for one option. */
export function optionLabel(option: StudioParamOption): string {
  return option.label ?? String(option.value)
}

/** Whether a value counts as "not set". */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'number') return !Number.isFinite(value)
  return false
}

/**
 * Coerce one raw value against its declared field.
 * @param field - declared field.
 * @param raw - user value.
 * @returns `{ value }` on success, `{ warning }` when the value is unusable.
 */
export function coerceParamValue(field: StudioParamField, raw: unknown): { value?: unknown; warning?: string } {
  const label = paramLabel(field)
  switch (field.kind) {
    case 'enum': {
      const options = field.options ?? []
      if (options.length === 0) return { value: raw }
      const match = options.find(option => option.value === raw)
        ?? options.find(option => String(option.value) === String(raw))
      if (match === undefined) return { warning: `${label}：${String(raw)} 不在可选值内` }
      return { value: match.value }
    }
    case 'multi': {
      const list = Array.isArray(raw) ? raw : isEmpty(raw) ? [] : [raw]
      const options = field.options ?? []
      const values: unknown[] = []
      for (const item of list) {
        const match = options.length === 0
          ? item
          : options.find(option => option.value === item || String(option.value) === String(item))?.value
        if (match === undefined) {
          return { warning: `${label}：${String(item)} 不在可选值内` }
        }
        values.push(match)
      }
      return { value: values }
    }
    case 'number': {
      const numeric = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(numeric)) return { warning: `${label} 需要数字` }
      const min = field.min ?? Number.NEGATIVE_INFINITY
      const max = field.max ?? Number.POSITIVE_INFINITY
      const clamped = Math.min(max, Math.max(min, numeric))
      return { value: clamped }
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw }
      const text = String(raw).trim().toLowerCase()
      if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return { value: true }
      if (text === 'false' || text === '0' || text === 'no' || text === 'off') return { value: false }
      return { warning: `${label} 需要布尔值` }
    }
    case 'json': {
      if (typeof raw !== 'string') return { value: raw }
      if (raw.trim() === '') return { value: undefined }
      try {
        return { value: JSON.parse(raw) as unknown }
      } catch {
        return { warning: `${label} 不是合法 JSON` }
      }
    }
    case 'longtext':
    case 'string':
    default:
      return { value: typeof raw === 'string' ? raw : String(raw) }
  }
}

/** Encode one resolved value for the wire. */
function encodeValue(field: StudioParamField, value: unknown): unknown {
  // An enum / multi choice may carry its own wire token, which wins over every
  // encoder: the vendor token is already the exact thing to send.
  if (field.kind === 'enum') {
    const option = (field.options ?? []).find(item => item.value === value)
    if (option?.wire !== undefined) return option.wire
  }
  if (field.kind === 'multi' && Array.isArray(value)) {
    const tokens = value.map(item => (field.options ?? []).find(option => option.value === item)?.wire ?? item)
    return field.encode === 'csv' ? tokens.map(token => String(token)).join(',') : tokens
  }
  switch (field.encode) {
    case 'string': return String(value)
    case 'number': return Number(value)
    case 'boolean': return Boolean(value)
    case 'bool01': return value === true || value === 'true' ? 1 : 0
    case 'csv': return Array.isArray(value) ? value.map(item => String(item)).join(',') : String(value)
    case 'json': return JSON.stringify(value)
    case 'raw':
    default: return value
  }
}

/** Body patch for every active enum / multi choice. */
function optionPatches(fields: readonly StudioParamField[], values: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.kind !== 'enum' && field.kind !== 'multi') continue
    const value = values[field.key]
    const active = field.kind === 'multi'
      ? (Array.isArray(value) ? value : [])
      : [value]
    for (const item of active) {
      const option = (field.options ?? []).find(candidate => candidate.value === item)
      if (option?.patch !== undefined) Object.assign(patch, option.patch)
    }
  }
  return patch
}

/**
 * Resolve one parameter state into panel values, canonical roles and wire extras.
 *
 * Defaults are applied only for fields the user has not set, so a cleared field
 * (empty string) stays cleared instead of snapping back.
 * @param fields - fields visible on this surface.
 * @param state - user values keyed by field key.
 * @returns the resolution result; `warnings` explains every rejected value.
 */
export function resolveStudioParams(fields: readonly StudioParamField[], state: Record<string, unknown>): StudioResolvedParams {
  const values: Record<string, unknown> = {}
  const roles: StudioRoleValues = {}
  const body: Record<string, unknown> = {}
  const query: Record<string, string> = {}
  const headers: Record<string, string> = {}
  const warnings: string[] = []

  for (const field of fields) {
    const raw = state[field.key] !== undefined ? state[field.key] : field.default
    const coerced = coerceParamValue(field, raw)
    if (coerced.warning !== undefined) {
      warnings.push(coerced.warning)
      continue
    }
    const value = coerced.value
    values[field.key] = value

    if (roleOf(field) !== 'custom' && value !== undefined) assignRole(roles, field, value as string | number)

    const skip = !field.always && (
      isEmpty(value)
      || (field.omitWhenDefault && field.default !== undefined && String(value) === String(field.default))
    )
    if (skip) continue

    const encoded = encodeValue(field, value)
    if (encoded === undefined) continue
    const name = field.name ?? field.key
    if (field.target === 'header') headers[name] = String(encoded)
    else if (field.target === 'query') query[name] = String(encoded)
    else body[name] = encoded
  }

  const patch = optionPatches(fields, values)
  return {
    values,
    roles,
    extras: {
      ...Object.keys(body).length === 0 && Object.keys(patch).length === 0 ? {} : { body: { ...body, ...patch } },
      ...Object.keys(query).length === 0 ? {} : { query },
      ...Object.keys(headers).length === 0 ? {} : { headers },
    },
    warnings,
  }
}

/** Role of a field, defaulting to `custom`. */
function roleOf(field: StudioParamField): StudioParamRole {
  return field.role ?? 'custom'
}

/** Write one value into its canonical slot. */
function assignRole(roles: StudioRoleValues, field: StudioParamField, value: string | number): void {
  switch (roleOf(field)) {
    case 'model': roles.model = String(value); return
    case 'prompt': roles.prompt = String(value); return
    case 'size': roles.size = String(value); return
    case 'aspect': roles.aspect = String(value); return
    case 'resolution': roles.resolution = String(value); return
    case 'duration': roles.duration = Number(value); return
    case 'n': roles.n = Number(value); return
    case 'seed': roles.seed = Number(value); return
    case 'negativePrompt': roles.negativePrompt = String(value); return
    default: return
  }
}

/**
 * The declared defaults, as a request state.
 *
 * Roles that carry a required slot (`size`, `duration`) are seeded too, so a
 * freshly selected model starts on a legal request instead of an empty one.
 * @param fields - declared fields for the model.
 * @returns a state map suitable for {@link resolveStudioParams}.
 */
export function defaultParamState(fields: readonly StudioParamField[]): Record<string, unknown> {
  const state: Record<string, unknown> = {}
  for (const field of fields) {
    // An enum control always *shows* something, so the wire value has to match
    // what is shown. Leaving it unset makes the browser render the first option
    // while the request omits the field -- the two disagree silently, and the
    // user cannot tell which one the gateway received.
    const fallback = field.kind === 'enum' ? field.options?.[0]?.value : undefined
    const value = field.default !== undefined ? field.default : fallback
    if (value !== undefined) state[field.key] = value
  }
  return state
}

/**
 * Drop state keys the model no longer declares.
 *
 * Switching models must not smuggle a previous model's knob into the next
 * request: a stale `steps: 50` on a model that has no `steps` would be sent as
 * an unknown body field and rejected upstream.
 * @param fields - declared fields for the new model.
 * @param state - previous state.
 * @returns the state restricted to declared keys, defaults filled in.
 */
export function pruneParamState(fields: readonly StudioParamField[], state: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const field of fields) {
    if (state[field.key] !== undefined) next[field.key] = state[field.key]
    else if (field.default !== undefined) next[field.key] = field.default
  }
  return next
}

/** One-line summary of a field, for the confirm card. */
export function describeParamValue(field: StudioParamField, value: unknown): string | undefined {
  if (isEmpty(value)) return undefined
  if (field.kind === 'enum') {
    const option = (field.options ?? []).find(item => item.value === value)
    return option === undefined ? String(value) : optionLabel(option)
  }
  if (field.kind === 'multi' && Array.isArray(value)) {
    return value
      .map(item => (field.options ?? []).find(option => option.value === item))
      .map(option => option === undefined ? '' : optionLabel(option))
      .filter(label => label !== '')
      .join(' / ')
  }
  if (field.kind === 'boolean') return value === true ? '开' : '关'
  if (field.kind === 'number') return `${String(value)}${field.unit ?? ''}`
  if (field.kind === 'json' || typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
