/**
 * 「模型参数」抽屉 — one model of one channel, opened from its catalogue row.
 *
 * The settings page owns the channel: one endpoint, one key, one catalogue per
 * media kind. What a row of that catalogue cannot express is what the model
 * accepts — a gateway that names its fields `image_size`, `mode` or
 * `duration_seconds`, returns its task under `data.task_id`, or takes a size
 * list per model. This drawer edits exactly that, for exactly the model whose
 * 「参数」button was pressed: its knobs, its declared parameters and, under
 * 高级, the wire contract the whole channel shares.
 *
 * The channel stays the source of truth about WHICH models exist, so a model
 * removed there disappears here too, and a model added there shows up with an
 * empty parameter list — never with invented fields.
 *
 * Fidelity rule: every draft carries the object it was built from, and saving
 * merges the edited scalars back onto it. A field this drawer does not expose
 * (an option's `wire` token or `patch`, a body template) therefore survives a
 * round-trip instead of being silently dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { listAdapters, previewRequest, saveAdapter } from './studio-api.ts'
import { defaultChannelAdapter, type StudioChannelLike, type StudioChannelModel } from '../studio/channel-adapters.ts'
import { imageModelPresets, videoModelPresets } from '../studio/model-presets.ts'
import { DEFAULT_FIELDS, type AdapterFieldMap, type AdapterKind, type AdapterModelSpec, type AdapterProfile } from '../studio/adapter-spec.ts'
import type { StudioParamField, StudioParamKind } from '../studio/param-schema.ts'
import css from './studio-channels.module.css'

/** One parameter row: the original object plus the scalar edits. */
interface ParamDraft {
  base: Record<string, unknown>
  key: string
  kind: string
  label: string
  role: string
  target: string
  name: string
  defaultText: string
  optionsText: string
  unit: string
  min: string
  max: string
  surfaces: string
  help: string
}

/** One model row. */
interface ModelDraft {
  base: Record<string, unknown>
  alias: string
  id: string
  durations: string
  resolutions: string
  ratios: string
  maxRef: string
  params: ParamDraft[]
}

/** One adapter row: the channel shared wire contract. */
interface AdapterDraft {
  base: Record<string, unknown>
  id: string
  label: string
  kind: string
  baseUrl: string
  authStyle: string
  headerName: string
  queryName: string
  prefix: string
  method: string
  path: string
  contentType: string
  pollPath: string
  taskIdPath: string
  statusPath: string
  urlPaths: string
  b64Paths: string
  /** Wire name typed in 「字段名」; empty keeps the engine default. */
  fieldsText: Record<FieldKey, string>
  /** Rows ticked 「不发」: the engine drops that parameter instead of naming it. */
  fieldsOff: Record<FieldKey, boolean>
  /** Reference-image encoding; empty keeps the engine default. */
  imageMode: string
  models: ModelDraft[]
}

/** A status line shown at the bottom of the drawer. */
interface DrawerMessage {
  kind: 'info' | 'error'
  text: string
  warnings?: string[]
}

const PARAM_KINDS: StudioParamKind[] = [
  'string', 'longtext', 'number', 'boolean', 'enum', 'multi', 'json',
]

const PARAM_ROLES = ['custom', 'model', 'prompt', 'size', 'aspect', 'resolution', 'duration', 'seed', 'negativePrompt', 'n'] as const
const PARAM_TARGETS = ['body', 'query', 'header'] as const
const AUTH_STYLES = ['bearer', 'header', 'query', 'none'] as const
const SURFACES = ['image', 'edit', 'video'] as const

/** Every knob the engine can name on the wire, in the order the drawer shows it. */
const FIELD_KEYS = ['model', 'prompt', 'size', 'aspect', 'resolution', 'duration', 'n', 'seed', 'negativePrompt', 'image', 'firstFrame', 'lastFrame', 'refVideos', 'refAudios'] as const
type FieldKey = typeof FIELD_KEYS[number]

/** Row label of one field name. */
const FIELD_LABELS: Record<FieldKey, string> = {
  model: '模型 ID',
  prompt: '提示词',
  size: '像素尺寸',
  aspect: '画幅',
  resolution: '清晰度',
  duration: '时长',
  n: '张数',
  seed: '种子',
  negativePrompt: '反向提示词',
  image: '参考图',
  firstFrame: '首帧',
  lastFrame: '尾帧',
  refVideos: '参考视频',
  refAudios: '参考音频',
}

/**
 * What an empty box means, shown as the placeholder: the name the engine would
 * send by default, or 「默认不发」 for the knobs that are absent until named.
 */
const FIELD_PLACEHOLDER: Record<FieldKey, string> = {
  model: DEFAULT_FIELDS.model,
  prompt: DEFAULT_FIELDS.prompt,
  size: DEFAULT_FIELDS.size,
  aspect: DEFAULT_FIELDS.aspect,
  resolution: DEFAULT_FIELDS.resolution,
  duration: DEFAULT_FIELDS.duration,
  n: DEFAULT_FIELDS.n,
  seed: '默认不发',
  negativePrompt: '默认不发',
  image: DEFAULT_FIELDS.image,
  firstFrame: DEFAULT_FIELDS.firstFrame,
  lastFrame: DEFAULT_FIELDS.lastFrame,
  refVideos: '默认不发',
  refAudios: '默认不发',
}

/**
 * Field-map slots a declared parameter role takes over.
 *
 * The host lets a declared `role` win over the name written here (otherwise the
 * same knob would be sent twice), so the drawer marks those rows instead of
 * letting the user wonder why an edit does nothing.
 */
const FIELD_ROLES: Partial<Record<FieldKey, string>> = {
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

/** Reference-image encodings; the empty option keeps the engine default. */
const IMAGE_MODES = ['', 'data-uri-array', 'base64-array', 'url-array', 'single-data-uri', 'first-last-object', 'multipart-file'] as const

/** Join a list into the comma-separated form the editor shows. */
function listToText(value: unknown): string {
  return Array.isArray(value) ? value.map(item => String(item)).join(', ') : ''
}

/** Split a comma/空格-separated list, keeping only non-empty entries. */
function textToList(text: string): string[] {
  return text.split(/[,，\s]+/).map(item => item.trim()).filter(item => item !== '')
}

/** Render a JSON-ish default value for a text input. */
function defaultToText(value: unknown): string {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Parse the default box: plain text stays text, JSON-ish text becomes JSON. */
function textToDefault(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
    try { return JSON.parse(trimmed) as unknown } catch { return trimmed }
  }
  return trimmed
}

/** One option per line, written `value` or `value | label`. */
function optionsToText(options: unknown): string {
  if (!Array.isArray(options)) return ''
  return options.map(option => {
    if (option === null || typeof option !== 'object') return String(option)
    const record = option as Record<string, unknown>
    const value = record.value === undefined ? '' : String(record.value)
    const label = typeof record.label === 'string' ? record.label : ''
    return label === '' ? value : `${value} | ${label}`
  }).join('\n')
}

/**
 * Rebuild the option list, keeping the original object (and therefore its
 * `wire` token and `patch`) when the value is unchanged.
 * @param text - the editor text.
 * @param previous - the options the row started with.
 */
function textToOptions(text: string, previous: unknown): Record<string, unknown>[] | undefined {
  const prior = Array.isArray(previous) ? previous : []
  const rows = text.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (rows.length === 0) return undefined
  return rows.map(line => {
    const [rawValue, rawLabel] = line.split('|').map(part => part.trim())
    const value = textToDefault(rawValue ?? '')
    const match = prior.find(option => option !== null && typeof option === 'object'
      && String((option as Record<string, unknown>).value) === String(value))
    const merged: Record<string, unknown> = match === undefined ? {} : { ...match as Record<string, unknown> }
    merged.value = value === undefined ? '' : value
    if (rawLabel !== undefined && rawLabel !== '') merged.label = rawLabel
    else delete merged.label
    return merged
  })
}

/** Build one parameter draft from a stored field. */
function paramDraft(field: Partial<StudioParamField> & Record<string, unknown>): ParamDraft {
  return {
    base: field as Record<string, unknown>,
    key: typeof field.key === 'string' ? field.key : '',
    kind: typeof field.kind === 'string' ? field.kind : 'string',
    label: typeof field.label === 'string' ? field.label : '',
    role: typeof field.role === 'string' ? field.role : 'custom',
    target: typeof field.target === 'string' ? field.target : 'body',
    name: typeof field.name === 'string' ? field.name : '',
    defaultText: defaultToText(field.default),
    optionsText: optionsToText(field.options),
    unit: typeof field.unit === 'string' ? field.unit : '',
    min: typeof field.min === 'number' ? String(field.min) : '',
    max: typeof field.max === 'number' ? String(field.max) : '',
    surfaces: Array.isArray(field.surfaces) ? field.surfaces.join(', ') : '',
    help: typeof field.help === 'string' ? field.help : '',
  }
}

/** Serialize one parameter draft back onto its original object. */
function paramPayload(draft: ParamDraft): Record<string, unknown> {
  const out: Record<string, unknown> = { ...draft.base, key: draft.key.trim(), kind: draft.kind }
  const assign = (name: string, value: unknown): void => {
    if (value === undefined || value === '') delete out[name]
    else out[name] = value
  }
  assign('label', draft.label.trim())
  assign('role', draft.role === 'custom' ? '' : draft.role)
  assign('target', draft.target === 'body' ? '' : draft.target)
  assign('name', draft.name.trim())
  assign('unit', draft.unit.trim())
  assign('min', draft.min.trim() === '' ? '' : Number(draft.min))
  assign('max', draft.max.trim() === '' ? '' : Number(draft.max))
  assign('help', draft.help.trim())
  const surfaces = textToList(draft.surfaces).filter(item => (SURFACES as readonly string[]).includes(item))
  assign('surfaces', surfaces.length === 0 ? '' : surfaces)
  assign('default', textToDefault(draft.defaultText))
  const options = textToOptions(draft.optionsText, draft.base.options)
  assign('options', options === undefined ? '' : options)
  return out
}

/** Build one model draft. */
function modelDraft(model: Record<string, unknown>): ModelDraft {
  const params = Array.isArray(model.params) ? model.params : []
  return {
    base: model,
    alias: typeof model.alias === 'string' ? model.alias : '',
    id: typeof model.id === 'string' ? model.id : '',
    durations: listToText(model.durations),
    resolutions: listToText(model.resolutions),
    ratios: listToText(model.aspectRatios),
    maxRef: typeof model.maxRefImages === 'number' ? String(model.maxRefImages) : '',
    params: params.flatMap(entry => entry === null || typeof entry !== 'object' ? [] : [paramDraft(entry as Record<string, unknown>)]),
  }
}

/** Serialize one model draft. */
function modelPayload(draft: ModelDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...draft.base,
    alias: draft.alias.trim(),
    id: draft.id.trim() === '' ? draft.alias.trim() : draft.id.trim(),
  }
  const durations = textToList(draft.durations).map(item => Number(item)).filter(item => Number.isFinite(item))
  if (durations.length === 0) delete out.durations
  else out.durations = durations
  const resolutions = textToList(draft.resolutions)
  if (resolutions.length === 0) delete out.resolutions
  else out.resolutions = resolutions
  const ratios = textToList(draft.ratios)
  if (ratios.length === 0) delete out.aspectRatios
  else out.aspectRatios = ratios
  if (draft.maxRef.trim() === '') delete out.maxRefImages
  else out.maxRefImages = Number(draft.maxRef)
  const params = draft.params.map(paramPayload).filter(field => typeof field.key === 'string' && field.key !== '')
  if (params.length === 0) delete out.params
  else out.params = params
  return out
}

/**
 * Read a stored field map into drawer state.
 *
 * `null` is the stored form of 「不发」; anything else is a name. A key the map
 * does not mention keeps the engine default and stays an empty box.
 * @param raw - the profile's `fields`.
 * @returns the texts, the disabled flags and the image mode.
 */
function fieldsState(raw: unknown): { text: Record<FieldKey, string>; off: Record<FieldKey, boolean>; imageMode: string } {
  const map = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const text = {} as Record<FieldKey, string>
  const off = {} as Record<FieldKey, boolean>
  for (const key of FIELD_KEYS) {
    const value = map[key]
    text[key] = typeof value === 'string' ? value : ''
    off[key] = value === null
  }
  return { text, off, imageMode: typeof map.imageMode === 'string' ? map.imageMode : '' }
}

/** Build one adapter draft from a derived profile. */
function adapterDraft(profile: Record<string, unknown>): AdapterDraft {
  const auth = (profile.auth ?? {}) as Record<string, unknown>
  const submit = (profile.submit ?? {}) as Record<string, unknown>
  const poll = (profile.poll ?? {}) as Record<string, unknown>
  const result = (profile.result ?? {}) as Record<string, unknown>
  const models = Array.isArray(profile.models) ? profile.models : []
  const fields = fieldsState(profile.fields)
  return {
    base: profile,
    id: typeof profile.id === 'string' ? profile.id : '',
    label: typeof profile.label === 'string' ? profile.label : '',
    kind: profile.kind === 'video' ? 'video' : 'image',
    baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : '',
    authStyle: typeof auth.style === 'string' ? auth.style : 'bearer',
    headerName: typeof auth.headerName === 'string' ? auth.headerName : '',
    queryName: typeof auth.queryName === 'string' ? auth.queryName : '',
    prefix: typeof auth.prefix === 'string' ? auth.prefix : '',
    method: submit.method === 'GET' ? 'GET' : 'POST',
    path: typeof submit.path === 'string' ? submit.path : '',
    contentType: typeof submit.contentType === 'string' ? submit.contentType : 'json',
    pollPath: typeof poll.path === 'string' ? poll.path : '',
    taskIdPath: typeof poll.taskIdPath === 'string' ? poll.taskIdPath : '',
    statusPath: typeof poll.statusPath === 'string' ? poll.statusPath : '',
    urlPaths: listToText(result.urlPaths),
    b64Paths: listToText(result.b64Paths),
    fieldsText: fields.text,
    fieldsOff: fields.off,
    imageMode: fields.imageMode,
    models: models.flatMap(entry => entry === null || typeof entry !== 'object' ? [] : [modelDraft(entry as Record<string, unknown>)]),
  }
}

/**
 * Serialize one adapter draft, keeping every field the drawer does not show.
 *
 * The credential is deliberately absent: the channel row owns the key, and the
 * host keeps `adapters.json` key-free.
 * @param draft - the edited adapter.
 * @param models - the complete model list to store (the channels own the ids).
 */
function adapterPayload(draft: AdapterDraft, models: Record<string, unknown>[]): Record<string, unknown> {
  const base = draft.base
  const authBase = (base.auth ?? {}) as Record<string, unknown>
  const submitBase = (base.submit ?? {}) as Record<string, unknown>
  const pollBase = (base.poll ?? {}) as Record<string, unknown>
  const resultBase = (base.result ?? {}) as Record<string, unknown>
  const auth: Record<string, unknown> = { ...authBase, style: draft.authStyle }
  delete auth.token
  delete auth.masked
  delete auth.hasToken
  if (draft.authStyle === 'header') {
    if (draft.headerName.trim() !== '') auth.headerName = draft.headerName.trim()
    else delete auth.headerName
  } else delete auth.headerName
  if (draft.authStyle === 'query') {
    if (draft.queryName.trim() !== '') auth.queryName = draft.queryName.trim()
    else delete auth.queryName
  } else delete auth.queryName
  if (draft.prefix.trim() !== '') auth.prefix = draft.prefix.trim()
  else delete auth.prefix
  const payload: Record<string, unknown> = {
    ...base,
    id: draft.id,
    label: draft.label.trim(),
    kind: draft.kind,
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
    auth,
    submit: {
      ...submitBase,
      method: draft.method,
      path: draft.path.trim(),
      contentType: draft.contentType,
    },
    result: { ...resultBase },
    models,
  }
  delete payload.fields
  const fields: AdapterFieldMap & Record<string, unknown> = {}
  for (const key of FIELD_KEYS) {
    if (draft.fieldsOff[key]) {
      // An explicit `null` survives every layer, which is how a model stops the
      // engine from sending a parameter the gateway rejects.
      fields[key] = null
      continue
    }
    const text = draft.fieldsText[key].trim()
    if (text !== '') fields[key] = text
  }
  if (draft.imageMode !== '') fields.imageMode = draft.imageMode as AdapterFieldMap['imageMode']
  // A ratio table is not a row of this drawer; keep whatever the profile had.
  if (typeof base.fields === 'object' && base.fields !== null) {
    const existing = base.fields as Record<string, unknown>
    if (existing.sizeByRatio !== undefined) fields.sizeByRatio = existing.sizeByRatio as Record<string, string>
  }
  if (Object.keys(fields).length > 0) payload.fields = fields
  const urlPaths = textToList(draft.urlPaths)
  const b64Paths = textToList(draft.b64Paths)
  const result = payload.result as Record<string, unknown>
  if (urlPaths.length === 0) delete result.urlPaths
  else result.urlPaths = urlPaths
  if (b64Paths.length === 0) delete result.b64Paths
  else result.b64Paths = b64Paths
  if (draft.pollPath.trim() === '') delete payload.poll
  else {
    payload.poll = {
      ...pollBase,
      path: draft.pollPath.trim(),
      ...draft.taskIdPath.trim() === '' ? {} : { taskIdPath: draft.taskIdPath.trim() },
      ...draft.statusPath.trim() === '' ? { statusPath: undefined } : { statusPath: draft.statusPath.trim() },
    }
    const poll = payload.poll as Record<string, unknown>
    if (poll.statusPath === undefined) delete poll.statusPath
  }
  return payload
}

/** Small text row used across the drawer. */
function Row(props: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className={css.row}>
      <span className={css.rowLabel}>{props.label}</span>
      {props.children}
      {props.hint === undefined ? null : <small className={css.rowHint}>{props.hint}</small>}
    </label>
  )
}

/** Props of the per-model drawer. */
export interface ModelParamsDrawerProps {
  /** The settings channel that owns this model. */
  channel: StudioChannelLike
  /** Which catalogue the model came from. */
  kind: AdapterKind
  /** The catalogue entry whose 「参数」button opened this drawer. */
  model: StudioChannelModel
  /** False disables saving (a read-only settings document). */
  writable?: boolean
  onClose: () => void
}

/**
 * One model's parameter panel, opened from its row in the channel's catalogue.
 * @param props - channel, media kind, model, close handler.
 * @returns the drawer, rendered into `document.body`.
 */
export function ModelParamsDrawer(props: ModelParamsDrawerProps): React.ReactElement {
  const { channel, kind, model, onClose } = props
  const writable = props.writable !== false
  const [draft, setDraft] = useState<AdapterDraft | undefined>(undefined)
  const [values, setValues] = useState<ModelDraft | undefined>(undefined)
  const [index, setIndex] = useState(-1)
  const [advanced, setAdvanced] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const [message, setMessage] = useState<DrawerMessage | undefined>(undefined)

  // The channel object is read, not watched: editing another field of the
  // settings form must not throw away parameters typed in here.
  const channelRef = useRef(channel)
  channelRef.current = channel
  const channelId = channel.id
  const channelName = channel.name ?? ''
  const apiUrl = channel.apiUrl
  const apiUrlFull = channel.apiUrlFull === true

  useEffect(() => {
    let live = true
    setDraft(undefined)
    setValues(undefined)
    setMessage(undefined)
    void (async () => {
      // The host derives the same adapter from the same channel, so a saved
      // channel and an unsaved draft start from identical defaults. A failed
      // read is not fatal: the local derivation is editable, and saving reports
      // the real error.
      const fallback = defaultChannelAdapter(channelRef.current, kind)
      let profile: AdapterProfile = fallback
      try {
        const response = await listAdapters()
        const found = (response.adapters as unknown[]).find(entry =>
          entry !== null && typeof entry === 'object' && (entry as { id?: unknown }).id === fallback.id)
        if (found !== undefined) profile = found as AdapterProfile
      } catch { /* an unreachable host must not block parameter editing */ }
      if (!live) return
      const at = profile.models.findIndex(entry => entry.alias === model.alias || entry.id === model.id)
      const target: Record<string, unknown> = at === -1
        ? { alias: model.alias, id: model.id }
        : profile.models[at] as unknown as Record<string, unknown>
      setDraft(adapterDraft(profile as unknown as Record<string, unknown>))
      setValues(modelDraft(target))
      setIndex(at)
      setPresetId('')
    })()
    return () => { live = false }
  }, [channelId, channelName, apiUrl, apiUrlFull, kind, model.alias, model.id])

  const presets: AdapterModelSpec[] = useMemo(
    () => kind === 'video' ? videoModelPresets() : imageModelPresets(),
    [kind],
  )

  /** A shipped template whose upstream id (or alias) is this model. */
  const matched = useMemo(
    () => presets.find(entry => entry.id === model.id || entry.alias === model.alias),
    [presets, model.id, model.alias],
  )

  const patchAdapter = useCallback((updater: (current: AdapterDraft) => AdapterDraft): void => {
    setDraft(current => current === undefined ? current : updater(current))
  }, [])

  const patchValues = useCallback((updater: (current: ModelDraft) => ModelDraft): void => {
    setValues(current => current === undefined ? current : updater(current))
  }, [])

  const patchParam = useCallback((paramIndex: number, field: keyof ParamDraft, value: string): void => {
    patchValues(current => ({
      ...current,
      params: current.params.map((param, at) => at === paramIndex ? { ...param, [field]: value } : param),
    }))
  }, [patchValues])

  /**
   * Copy one template's knobs onto this model. The alias and the upstream id
   * stay the channel's: a template only ever fills what the model accepts.
   * @param alias - preset alias selected in the dropdown.
   */
  const applyPreset = useCallback((alias: string): void => {
    const preset = presets.find(entry => entry.alias === alias)
    if (preset === undefined) return
    patchValues(current => modelDraft({
      ...current.base,
      ...preset.aspectRatios === undefined ? {} : { aspectRatios: preset.aspectRatios },
      ...preset.resolutions === undefined ? {} : { resolutions: preset.resolutions },
      ...preset.durations === undefined ? {} : { durations: preset.durations },
      ...preset.maxRefImages === undefined ? {} : { maxRefImages: preset.maxRefImages },
      ...preset.extra === undefined ? {} : { extra: preset.extra },
      ...preset.fieldOverrides === undefined ? {} : { fieldOverrides: preset.fieldOverrides },
      ...preset.priceNote === undefined ? {} : { priceNote: preset.priceNote },
      ...preset.params === undefined ? {} : { params: preset.params },
      alias: current.alias,
      id: current.id,
    }))
    setPresetId('')
  }, [presets, patchValues])

  const save = useCallback(async (): Promise<void> => {
    if (draft === undefined || values === undefined) return
    setBusy(true)
    setMessage(undefined)
    try {
      const edited = modelPayload(values)
      // The whole catalogue is written back: the store keeps one record per
      // channel, so a single-model write would drop the other models' fields.
      const models = draft.models.map((entry, at) => at === index ? edited : modelPayload(entry))
      const response = await saveAdapter(adapterPayload(draft, index === -1 ? [...models, edited] : models))
      const warnings = (Array.isArray(response.warnings) ? response.warnings : [])
        .filter(warning => !warning.startsWith('未填写密钥'))
      setMessage({
        kind: warnings.length === 0 ? 'info' : 'error',
        text: warnings.length === 0 ? '已保存：普通生图与无限画布立即生效' : '已保存，但有字段被上游规范化丢弃',
        warnings,
      })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }, [draft, values, index])

  /**
   * Render the exact wire request for this model without sending it.
   *
   * It runs against the draft in the drawer, so a field name, a path or an
   * encoding can be checked before anything is saved — and the parameter
   * defaults are filled in, so the body shows realistic values instead of bare
   * keys. This is the fastest way to see why a gateway ignores a knob.
   */
  const runPreview = useCallback(async (): Promise<void> => {
    if (draft === undefined || values === undefined) return
    setBusy(true)
    setMessage(undefined)
    try {
      const params: Record<string, unknown> = {}
      for (const param of values.params) {
        const key = param.key.trim()
        const value = textToDefault(param.defaultText)
        if (key !== '' && value !== undefined) params[key] = value
      }
      const edited = modelPayload(values)
      const models = draft.models.map((entry, at) => at === index ? edited : modelPayload(entry))
      const result = await previewRequest({
        adapterId: draft.id,
        modelAlias: values.alias.trim() === '' ? values.id.trim() : values.alias.trim(),
        prompt: '一只橘猫趴在窗台上打盹，午后逆光',
        surface: draft.kind === 'video' ? 'video' : 'image',
        ...Object.keys(params).length === 0 ? {} : { params },
        adapter: adapterPayload(draft, index === -1 ? [...models, edited] : models),
      })
      setPreview({ ok: true, text: JSON.stringify(result, undefined, 2) })
    } catch (error) {
      setPreview({ ok: false, text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }, [draft, values, index])

  /**
   * The parameter that owns one field row, if the model declared one.
   * @param key - the field-map slot.
   * @returns the wire name the declared parameter will use instead.
   */
  const roleOwner = useCallback((key: FieldKey): string | undefined => {
    const role = FIELD_ROLES[key]
    if (role === undefined || values === undefined) return undefined
    const param = values.params.find(entry => entry.role === role)
    if (param === undefined) return undefined
    return param.name.trim() === '' ? param.key : param.name.trim()
  }, [values])

  const title = model.alias === '' ? model.id : model.alias

  return createPortal(
    <div
      className={css.overlay}
      role="dialog"
      aria-modal="true"
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className={css.drawer}>
        <div className={css.root}>
          <div className={css.head}>
            <div>
              <strong>模型参数 · {title}</strong>
              <p className={css.dim}>
                这里只描述这一个模型认什么参数。地址与密钥仍走渠道
                「{channelName.trim() === '' ? '未命名渠道' : channelName.trim()}」，
                发出去的 model 是 {model.id}；要改名或改上游 ID，回渠道里的模型目录。
              </p>
            </div>
            <div className={css.headActions}>
              <button type="button" className={css.ghost} onClick={onClose}>关闭</button>
            </div>
          </div>

          {draft === undefined || values === undefined
            ? <p className={css.dim}>正在读取该模型的参数…</p>
            : (
              <div className={css.body}>
                <div className={css.form}>
                  <div className={css.models}>
                    <div className={css.modelsHead}>
                      <strong>模型能力</strong>
                      {matched === undefined || values.params.length > 0
                        ? null
                        : <small className={css.dim}>内置模板「{matched.alias}」与它的上游 ID 相同，可用「填充」一次补好</small>}
                    </div>
                    <Row label="时长（秒）" hint="逗号分隔，例如 5, 10；视频用">
                      <input value={values.durations} disabled={!writable} onChange={event => { const value = event.target.value; patchValues(current => ({ ...current, durations: value })) }} />
                    </Row>
                    <Row label="清晰度" hint="逗号分隔，例如 480P, 720P, 1080P">
                      <input value={values.resolutions} disabled={!writable} onChange={event => { const value = event.target.value; patchValues(current => ({ ...current, resolutions: value })) }} />
                    </Row>
                    <Row label="画幅" hint="逗号分隔，例如 1:1, 16:9, 9:16">
                      <input value={values.ratios} disabled={!writable} onChange={event => { const value = event.target.value; patchValues(current => ({ ...current, ratios: value })) }} />
                    </Row>
                    <Row label="参考图上限" hint="0 表示不支持参考图；留空表示不限制">
                      <input value={values.maxRef} disabled={!writable} onChange={event => { const value = event.target.value; patchValues(current => ({ ...current, maxRef: value })) }} />
                    </Row>
                    <Row label="模板填充" hint="只填参数与能力，不改别名与上游 ID">
                      <div className={css.paramHead}>
                        <select value={presetId} disabled={!writable} onChange={event => { setPresetId(event.target.value) }}>
                          <option value="">选一个内置模板…</option>
                          {presets.map(preset => (
                            <option key={preset.id} value={preset.alias}>{preset.alias}（{preset.id}）</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={css.ghost}
                          disabled={!writable || (presetId === '' && matched === undefined)}
                          onClick={() => { applyPreset(presetId === '' ? matched?.alias ?? '' : presetId) }}
                        >
                          填充
                        </button>
                      </div>
                    </Row>
                  </div>

                  <div className={css.params}>
                    <div className={css.modelsHead}>
                      <strong>参数表（{String(values.params.length)}）</strong>
                      <button
                        type="button"
                        className={css.ghost}
                        disabled={!writable}
                        onClick={() => { patchValues(current => ({ ...current, params: [...current.params, paramDraft({ key: '' })] })) }}
                      >
                        + 加参数
                      </button>
                    </div>
                    <p className={css.dim}>
                      每个模型可以有自己的字段：控件类型、写到 body/query/header 的哪个名字、选项怎么显示与怎么发，
                      以及默认值。上游把「尺寸」叫 image_size、「时长」叫 duration_seconds，就在这里写清楚。
                      这些字段会出现在普通生图的参数胶囊里，也是 Agent 调用时能填的参数。
                    </p>
                    {values.params.length === 0
                      ? <p className={css.dim}>还没有参数：这个模型只会收到 prompt 与 model。</p>
                      : values.params.map((param, paramIndex) => (
                        <div key={`param-${String(paramIndex)}`} className={css.paramCard}>
                          <div className={css.paramHead}>
                            <input
                              className={css.paramKey}
                              value={param.key}
                              disabled={!writable}
                              placeholder="key（请求状态里的名字）"
                              onChange={event => { patchParam(paramIndex, 'key', event.target.value) }}
                            />
                            <select value={param.kind} disabled={!writable} onChange={event => { patchParam(paramIndex, 'kind', event.target.value) }}>
                              {PARAM_KINDS.map(entry => <option key={entry} value={entry}>{entry}</option>)}
                            </select>
                            <button
                              type="button"
                              className={css.danger}
                              disabled={!writable}
                              onClick={() => { patchValues(current => ({ ...current, params: current.params.filter((_, at) => at !== paramIndex) })) }}
                            >
                              删除
                            </button>
                          </div>
                          <div className={css.paramGrid}>
                            <Row label="显示名"><input value={param.label} disabled={!writable} onChange={event => { patchParam(paramIndex, 'label', event.target.value) }} /></Row>
                            <Row label="含义">
                              <select value={param.role} disabled={!writable} onChange={event => { patchParam(paramIndex, 'role', event.target.value) }}>
                                {PARAM_ROLES.map(role => <option key={role} value={role}>{role}</option>)}
                              </select>
                            </Row>
                            <Row label="写入位置">
                              <select value={param.target} disabled={!writable} onChange={event => { patchParam(paramIndex, 'target', event.target.value) }}>
                                {PARAM_TARGETS.map(target => <option key={target} value={target}>{target}</option>)}
                              </select>
                            </Row>
                            <Row label="上游字段名"><input value={param.name} disabled={!writable} placeholder="image_size" onChange={event => { patchParam(paramIndex, 'name', event.target.value) }} /></Row>
                            <Row label="默认值"><input value={param.defaultText} disabled={!writable} placeholder="留空表示不发送" onChange={event => { patchParam(paramIndex, 'defaultText', event.target.value) }} /></Row>
                            <Row label="单位"><input value={param.unit} disabled={!writable} placeholder="s / px" onChange={event => { patchParam(paramIndex, 'unit', event.target.value) }} /></Row>
                            <Row label="最小值"><input value={param.min} disabled={!writable} onChange={event => { patchParam(paramIndex, 'min', event.target.value) }} /></Row>
                            <Row label="最大值"><input value={param.max} disabled={!writable} onChange={event => { patchParam(paramIndex, 'max', event.target.value) }} /></Row>
                            <Row label="出现在哪些界面" hint="image / edit / video，逗号分隔；留空=全部">
                              <input value={param.surfaces} disabled={!writable} onChange={event => { patchParam(paramIndex, 'surfaces', event.target.value) }} />
                            </Row>
                          </div>
                          <Row label="选项" hint="每行一个：值 或 值 | 显示名；留空表示不是选择题">
                            <textarea rows={3} value={param.optionsText} disabled={!writable} onChange={event => { patchParam(paramIndex, 'optionsText', event.target.value) }} />
                          </Row>
                          <Row label="说明"><input value={param.help} disabled={!writable} onChange={event => { patchParam(paramIndex, 'help', event.target.value) }} /></Row>
                        </div>
                      ))}
                  </div>

                  <div className={css.models}>
                    <div className={css.modelsHead}>
                      <strong>接口协议</strong>
                      <button type="button" className={css.ghost} onClick={() => { setAdvanced(current => !current) }}>
                        {advanced ? '收起' : '展开（高级）'}
                      </button>
                    </div>
                    <p className={css.dim}>
                      这个渠道怎么发请求：所有模型共用一份。地址 {draft.baseUrl} 与密钥来自渠道行；
                      只有网关的字段名或路径与 OpenAI 不一样时才需要动这里。
                    </p>
                    {advanced
                      ? (
                        <>
                          <Row label="提交路径" hint="例：/v1/images/generations 或完整 URL">
                            <input value={draft.path} disabled={!writable} onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, path: value })) }} />
                          </Row>
                          <Row label="提交方式">
                            <select value={draft.method} disabled={!writable} onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, method: value })) }}>
                              <option value="POST">POST</option>
                              <option value="GET">GET</option>
                            </select>
                          </Row>
                          <Row label="编码">
                            <select value={draft.contentType} disabled={!writable} onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, contentType: value })) }}>
                              <option value="json">json</option>
                              <option value="multipart">multipart</option>
                              <option value="query">query</option>
                            </select>
                          </Row>
                          <Row label="鉴权">
                            <select value={draft.authStyle} disabled={!writable} onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, authStyle: value })) }}>
                              {AUTH_STYLES.map(style => <option key={style} value={style}>{style}</option>)}
                            </select>
                          </Row>
                          {draft.authStyle === 'header'
                            ? (
                              <Row label="密钥头名" hint="留空按 Authorization">
                                <input value={draft.headerName} disabled={!writable} placeholder="x-api-key" onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, headerName: value })) }} />
                              </Row>
                            )
                            : null}
                          {draft.authStyle === 'query'
                            ? (
                              <Row label="密钥参数名" hint="留空按 key">
                                <input value={draft.queryName} disabled={!writable} placeholder="key" onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, queryName: value })) }} />
                              </Row>
                            )
                            : null}
                          <Row label="前缀" hint="Bearer / Token 之类，留空按 bearer">
                            <input value={draft.prefix} disabled={!writable} onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, prefix: value })) }} />
                          </Row>
                          {draft.kind === 'video'
                            ? (
                              <>
                                <Row label="轮询路径" hint="留空表示同步返回；{{taskId}} 换成任务号">
                                  <input value={draft.pollPath} disabled={!writable} placeholder="v1/videos/{{taskId}}" onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, pollPath: value })) }} />
                                </Row>
                                <Row label="任务号字段" hint="从提交响应里取任务号的路径，默认 id">
                                  <input value={draft.taskIdPath} disabled={!writable} placeholder="id" onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, taskIdPath: value })) }} />
                                </Row>
                                <Row label="状态字段" hint="例：status">
                                  <input value={draft.statusPath} disabled={!writable} onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, statusPath: value })) }} />
                                </Row>
                              </>
                            )
                            : null}
                          <Row label="结果 URL 字段" hint="逗号分隔，按顺序探测，例如 data[].url, video_url">
                            <input value={draft.urlPaths} disabled={!writable} onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, urlPaths: value })) }} />
                          </Row>
                          <Row label="结果 Base64 字段" hint="逗号分隔，例如 data[].b64_json">
                            <input value={draft.b64Paths} disabled={!writable} onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, b64Paths: value })) }} />
                          </Row>
                          <div className={css.modelsHead}>
                            <strong>字段名</strong>
                            <small className={css.dim}>
                              留空＝用括号里的默认名；勾「不发」＝这个模型不收这个参数，引擎直接丢掉它
                            </small>
                          </div>
                          <div className={css.paramGrid}>
                            {FIELD_KEYS.map(key => {
                              const owner = roleOwner(key)
                              return (
                                <Row
                                  key={key}
                                  label={FIELD_LABELS[key]}
                                  hint={owner === undefined ? undefined : `由参数表「${owner}」接管，这里不用填`}
                                >
                                  <div className={css.paramHead}>
                                    <input
                                      value={draft.fieldsText[key]}
                                      disabled={!writable || draft.fieldsOff[key]}
                                      placeholder={FIELD_PLACEHOLDER[key]}
                                      onChange={event => {
                                        const value = event.target.value
                                        patchAdapter(current => ({ ...current, fieldsText: { ...current.fieldsText, [key]: value } }))
                                      }}
                                    />
                                    <label className={css.check}>
                                      <input
                                        type="checkbox"
                                        checked={draft.fieldsOff[key]}
                                        disabled={!writable}
                                        onChange={event => {
                                          const value = event.target.checked
                                          patchAdapter(current => ({ ...current, fieldsOff: { ...current.fieldsOff, [key]: value } }))
                                        }}
                                      />
                                      不发
                                    </label>
                                  </div>
                                </Row>
                              )
                            })}
                            <Row label="参考图编码" hint="multipart-file 时引擎改发表单；留空＝data-uri-array">
                              <select value={draft.imageMode} disabled={!writable} onChange={event => { const value = event.target.value; patchAdapter(current => ({ ...current, imageMode: value })) }}>
                                {IMAGE_MODES.map(mode => <option key={mode} value={mode}>{mode === '' ? '默认（data-uri-array）' : mode}</option>)}
                              </select>
                            </Row>
                          </div>
                        </>
                      )
                      : null}
                  </div>

                  {preview === undefined
                    ? null
                    : (
                      <div className={css.models}>
                        <div className={css.modelsHead}>
                          <strong>请求预览</strong>
                          <button type="button" className={css.ghost} onClick={() => { setPreview(undefined) }}>收起</button>
                        </div>
                        <p className={css.dim}>
                          下面就是这次会发出去的东西：真正的地址、脱敏后的头、请求体，以及哪些参数因为没给名字而被丢掉。
                          改完上面任何一格都可以再点一次。
                        </p>
                        <pre className={css.preview} data-ok={preview.ok}>{preview.text}</pre>
                      </div>
                    )}

                  <div className={css.footer}>
                    <button type="button" className={css.primary} disabled={!writable || busy} onClick={() => { void save() }}>
                      {busy ? '保存中…' : '保存参数'}
                    </button>
                    <button type="button" className={css.ghost} disabled={!writable || busy} onClick={() => { void runPreview() }}>
                      预览请求
                    </button>
                    <button type="button" className={css.ghost} onClick={onClose}>关闭</button>
                    {writable ? null : <small className={css.dim}>当前设置为只读</small>}
                    {message === undefined
                      ? null
                      : (
                        <span className={css.message} data-kind={message.kind}>
                          {message.text}
                          {message.warnings === undefined
                            ? null
                            : <ul>{message.warnings.map((warning, at) => <li key={String(at)}>{warning}</li>)}</ul>}
                        </span>
                      )}
                  </div>
                </div>
              </div>
            )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
