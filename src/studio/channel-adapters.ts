/**
 * dsh-imagegen-studio — a settings channel seen as a studio adapter.
 *
 * The settings page owns the catalogue: one endpoint, one key, one list of
 * models per media kind. The studio surfaces (普通生图 / 无限画布) speak
 * `AdapterProfile` instead, because they need per-model knobs the channel row
 * does not describe. This module is the bridge.
 *
 * The channel decides WHICH models exist; the stored override record only adds
 * what the channel cannot express — declared parameters, aspect ratios,
 * resolutions, reference-image limits and the wire contract. So removing a
 * model from the channel removes it from the studio too, and the endpoint and
 * key can never drift away from the channel they were configured in.
 *
 * Pure and browser-safe on purpose: the host routes and the settings drawer run
 * the same functions, so a channel that has never been saved shows exactly the
 * defaults the host would derive for it.
 */

import {
  DEFAULT_FIELDS,
  type AdapterFieldMap,
  type AdapterKind,
  type AdapterModelSpec,
  type AdapterProfile,
} from './adapter-spec.ts'

/** Field map for an OpenAI-compatible gateway: the stock vocabulary. */
export const OPENAI_FIELDS: AdapterFieldMap = {
  model: DEFAULT_FIELDS.model,
  prompt: DEFAULT_FIELDS.prompt,
  size: DEFAULT_FIELDS.size,
  aspect: DEFAULT_FIELDS.aspect,
  resolution: DEFAULT_FIELDS.resolution,
  duration: DEFAULT_FIELDS.duration,
  n: DEFAULT_FIELDS.n,
  image: DEFAULT_FIELDS.image,
  imageMode: DEFAULT_FIELDS.imageMode,
  firstFrame: DEFAULT_FIELDS.firstFrame,
  lastFrame: DEFAULT_FIELDS.lastFrame,
}

/** One catalogue entry of a channel: the alias the user sees, the upstream id. */
export interface StudioChannelModel {
  alias: string
  id: string
}

/** The subset of a settings channel this module needs. */
export interface StudioChannelLike {
  id: string
  name?: string
  apiUrl: string
  apiUrlFull?: boolean
  models?: ReadonlyArray<StudioChannelModel>
  videoModels?: ReadonlyArray<StudioChannelModel>
}

/** A channel plus the host-side key. The key never reaches the browser. */
export interface StudioChannelConfig extends StudioChannelLike {
  apiKey?: string
}

/** Suffix that separates one channel's video adapter from its image adapter. */
const VIDEO_ID_SUFFIX = '#video'

/** The id of the adapter derived from one channel and one media kind. */
export function channelAdapterId(channelId: string, kind: AdapterKind): string {
  return kind === 'video' ? `${channelId}${VIDEO_ID_SUFFIX}` : channelId
}

/** Split a derived adapter id back into its channel and media kind. */
export function splitChannelAdapterId(id: string): { channelId: string; kind: AdapterKind } {
  return id.endsWith(VIDEO_ID_SUFFIX)
    ? { channelId: id.slice(0, -VIDEO_ID_SUFFIX.length), kind: 'video' }
    : { channelId: id, kind: 'image' }
}

/** The models a channel declares for one media kind. */
export function channelModels(channel: StudioChannelLike, kind: AdapterKind): StudioChannelModel[] {
  const list = kind === 'video' ? channel.videoModels : channel.models
  return (list ?? []).map(model => ({ alias: model.alias, id: model.id }))
}

/** The adapter label shown in the studio pickers. */
export function channelAdapterLabel(channel: StudioChannelLike, kind: AdapterKind): string {
  const name = (channel.name ?? '').trim() === '' ? '未命名渠道' : (channel.name ?? '').trim()
  return kind === 'video' ? `${name} · 视频` : name
}

/** The path the stock engine appends to a channel's base URL. */
function submitSuffix(kind: AdapterKind): string {
  return kind === 'video' ? 'videos' : 'images/generations'
}

/**
 * The submit paths the stock engine knows, longest first.
 *
 * `apiUrlFull` names the exact SUBMIT url, so the base has to be recovered from
 * it before anything else can be resolved against it: the stock video engine
 * does the same when it derives a status URL (#5).
 */
const EXACT_TAILS: Record<AdapterKind, readonly string[]> = {
  video: ['/videos/generations', '/videos'],
  image: ['/images/generations', '/images/edits'],
}

/** The base URL implied by an exact submit URL, so polling keeps its prefix. */
function baseOfExact(url: string, kind: AdapterKind): string {
  const trimmed = url.replace(/\/+$/, '')
  for (const tail of EXACT_TAILS[kind]) {
    if (trimmed.endsWith(tail)) return trimmed.slice(0, trimmed.length - tail.length)
  }
  return trimmed
}

/**
 * The adapter a channel implies before anyone edited a single parameter.
 *
 * Endpoint resolution mirrors the stock engine: `apiUrl` is the base and
 * `/images/generations` (or `/videos`) is appended — unless the channel says
 * the URL is already exact, in which case the URL itself is the submit path.
 * @param channel - the settings channel.
 * @param kind - image or video pipeline.
 * @param apiKey - the host-side key, when one is known.
 */
export function defaultChannelAdapter(channel: StudioChannelLike, kind: AdapterKind, apiKey = ''): AdapterProfile {
  const url = channel.apiUrl.trim()
  const suffix = submitSuffix(kind)
  const exact = channel.apiUrlFull === true
  const path = url === ''
    ? suffix
    : exact || url.endsWith(`/${suffix}`)
      ? url
      : suffix
  const now = Date.now()
  const models: AdapterModelSpec[] = channelModels(channel, kind).map(model => ({ alias: model.alias, id: model.id }))
  const common = {
    id: channelAdapterId(channel.id, kind),
    label: channelAdapterLabel(channel, kind),
    kind,
    baseUrl: url === '' ? '' : exact ? baseOfExact(url, kind) : url,
    auth: { style: 'bearer' as const, token: apiKey.trim() },
    submit: { method: 'POST' as const, path, contentType: 'json' as const },
    result: kind === 'video'
      ? { urlPaths: ['video_url', 'url', 'metadata.url', 'data[].url'], mimePath: 'mime' }
      : { urlPaths: ['data[].url', 'data[].b64_json', 'url'], b64Paths: ['data[].b64_json'], revisedPromptPath: 'data[].revised_prompt' },
    fields: OPENAI_FIELDS,
    models,
    createdAt: now,
    updatedAt: now,
  }
  return kind === 'video'
    ? {
      ...common,
      poll: { path: 'videos/{{taskId}}', taskIdPath: 'id', statusPath: 'status', progressPath: 'progress', errorPath: 'error' },
    }
    : common
}

/** The editable half of a model: everything except who it is. */
function modelOverride(override: AdapterModelSpec | undefined): Partial<AdapterModelSpec> {
  if (override === undefined) return {}
  const { alias: _alias, id: _id, ...rest } = override
  return rest
}

/** Merge the stored override of one model onto the channel's catalogue entry. */
export function mergeModel(base: AdapterModelSpec, override?: AdapterModelSpec): AdapterModelSpec {
  return { ...base, ...modelOverride(override) }
}

/**
 * Derive one adapter from a channel, layering the stored override on top.
 *
 * Returns `undefined` when the channel declares no model of that kind: a
 * channel without video models has no video adapter to pick.
 * @param channel - the settings channel.
 * @param kind - image or video pipeline.
 * @param stored - the stored override record for this adapter id, if any.
 * @param apiKey - the host-side key, when one is known.
 */
export function deriveChannelAdapter(
  channel: StudioChannelLike,
  kind: AdapterKind,
  stored?: AdapterProfile,
  apiKey = '',
): AdapterProfile | undefined {
  const base = defaultChannelAdapter(channel, kind, apiKey)
  if (base.models.length === 0) return undefined
  if (stored === undefined) return base
  const byAlias = new Map<string, AdapterModelSpec>()
  for (const model of stored.models) {
    byAlias.set(model.alias, model)
    if (!byAlias.has(model.id)) byAlias.set(model.id, model)
  }
  const token = apiKey.trim() !== '' ? apiKey.trim() : (stored.auth.token ?? '')
  return {
    ...base,
    auth: { ...base.auth, ...stored.auth, token },
    submit: { ...base.submit, ...stored.submit },
    ...stored.poll === undefined ? {} : { poll: stored.poll },
    result: { ...base.result, ...stored.result },
    fields: stored.fields ?? base.fields,
    ...stored.note === undefined ? {} : { note: stored.note },
    createdAt: stored.createdAt,
    updatedAt: base.updatedAt,
    models: base.models.map(model => mergeModel(model, byAlias.get(model.alias) ?? byAlias.get(model.id))),
  }
}

/**
 * Every adapter the current channels imply, in channel order.
 * @param channels - the live settings channels.
 * @param stored - the override records read from `adapters.json`.
 * @param keyOf - host-side key lookup; omit in the browser.
 */
export function deriveChannelAdapters(
  channels: readonly StudioChannelLike[],
  stored: readonly AdapterProfile[],
  keyOf?: (channelId: string) => string,
): AdapterProfile[] {
  const byId = new Map(stored.map(adapter => [adapter.id, adapter]))
  const out: AdapterProfile[] = []
  for (const channel of channels) {
    for (const kind of ['image', 'video'] as const) {
      const id = channelAdapterId(channel.id, kind)
      const derived = deriveChannelAdapter(channel, kind, byId.get(id), keyOf?.(channel.id) ?? '')
      if (derived !== undefined) out.push(derived)
    }
  }
  return out
}

/** The derived adapter for one channel and kind, for a caller that has a list. */
export function findChannelAdapter(
  adapters: readonly AdapterProfile[],
  channelId: string,
  kind: AdapterKind,
): AdapterProfile | undefined {
  const id = channelAdapterId(channelId, kind)
  return adapters.find(adapter => adapter.id === id)
}
