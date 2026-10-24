/**
 * Studio wire contract, shared by the host routes and the browser panel.
 *
 * Kept free of `node:` imports on purpose: this file is inlined into the client
 * bundle, so it may only contain types and constants.
 */

import type { StudioParamField } from './param-schema.ts'
import type { StudioTaskView } from './tasks.ts'

/** Every route this module registers. */
export const STUDIO_API = {
  /** GET: masked adapter list. */
  adapters: '/api/dsh-imagegen-studio/studio/adapters',
  /** POST: create or update one adapter. */
  adapter: '/api/dsh-imagegen-studio/studio/adapter',
  /** POST: delete one adapter. */
  adapterDelete: '/api/dsh-imagegen-studio/studio/adapter/delete',
  /** POST: probe a gateway's /v1/models and suggest models. */
  discover: '/api/dsh-imagegen-studio/studio/discover',
  /** POST: append discovered models to the catalogue of the channel behind an adapter. */
  adopt: '/api/dsh-imagegen-studio/studio/adopt',
  /** POST: render the exact wire request without sending it. */
  preview: '/api/dsh-imagegen-studio/studio/preview',
  /** POST: start one chat generation (image or video). */
  generate: '/api/dsh-imagegen-studio/studio/generate',
  /** POST: start a tail-frame continuation chain. */
  continuum: '/api/dsh-imagegen-studio/studio/continuum',
  /** GET prefix: poll one task. */
  task: '/api/dsh-imagegen-studio/studio/task',
  /** POST: cancel one task. */
  cancel: '/api/dsh-imagegen-studio/studio/cancel',
  /** POST: record one renderer stall report (diagnostics only). */
  diag: '/api/dsh-imagegen-studio/studio/diag',
  /** GET prefix: serve a produced asset (supports Range). */
  file: '/api/dsh-imagegen-studio/studio/file',
} as const

/** One parameter value the panel keeps for a model. */
export type StudioParamState = Record<string, unknown>

/** A chat turn's generation request. */
export interface StudioGenerateRequest {
  adapterId: string
  modelAlias: string
  /** Which surface this turn uses; decides which declared fields apply. */
  surface: 'image' | 'edit' | 'video'
  prompt: string
  /** Values for the model's declared free-form parameters. */
  params?: StudioParamState
  /** Reference images as `data:` URIs, in order. */
  images?: string[]
  /** Reference videos as `data:` URIs. */
  videos?: string[]
  /** Reference audios as `data:` URIs. */
  audios?: string[]
  /** Keyframe pair, for models that accept both ends. */
  firstFrame?: string
  lastFrame?: string
  /** Overrides for the classic knobs, when the model exposes them. */
  aspect?: string
  resolution?: string
  size?: string
  duration?: number
  seed?: number
  n?: number
  negativePrompt?: string
  /** Attach the real wire request to the chat turn (for the "查看请求" drawer). */
  showWire?: boolean
}

/** A continuation request: render N segments joined by their tail frames. */
export interface StudioContinuumRequest {
  adapterId: string
  modelAlias: string
  prompt: string
  /** Segments to render; each is one paid render. */
  segments: number
  /** Clip length per segment. */
  seconds: number
  /** Text appended to every segment after the first. */
  promptStep?: string
  /** Starting frame, when continuing an existing clip. */
  seedFrame?: string
  /**
   * Continue an already-produced clip by its served URL. The host reads the last
   * frame off that file, so the browser never has to decode video.
   */
  seedFromUrl?: string
  aspect?: string
  resolution?: string
  seed?: number
  params?: StudioParamState
  /** Seam crossfade in ms; 0 = hard cut. */
  crossfadeMs?: number
}

/** Response of any start route. */
export interface StudioStartResponse {
  ok: true
  taskId: string
}

/** A failure shape used by every studio route. */
export interface StudioErrorResponse {
  ok: false
  code: string
  message: string
  warnings?: string[]
}

/** One discovered model, before it is saved into a profile. */
export interface StudioDiscoveredModel {
  id: string
  /** Suggested alias (the id, unless a pricing description renames it). */
  alias: string
  kind: 'image' | 'video'
  priceNote?: string
  description?: string
  /** Already declared by this adapter, so the panel can mark it rather than add it twice. */
  known: boolean
}

/** Result of a discovery probe. */
export interface StudioDiscoverResult {
  ok: boolean
  /** Raw endpoint that answered. */
  endpoint: string
  models: StudioDiscoveredModel[]
  message?: string
  /** The models endpoint this adapter was probed at. */
  hint?: string
}

/** A wire preview: exactly what would be sent, credentials redacted. */
export interface StudioPreviewResult {
  ok: true
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  contentType: string
  omitted: string[]
  /** Declared fields this model does not use, so the panel can explain itself. */
  unused: string[]
}

/** Full payload of the adapter list route. */
export interface StudioAdaptersResponse {
  ok: true
  /** One entry per channel that declares models of that kind. */
  adapters: unknown[]
}

/** Adopt discovered models into the channel behind one adapter. */
export interface StudioAdoptRequest {
  /** The derived adapter id; the host splits it into channel + media kind. */
  adapterId: string
  models: Array<{ alias: string; id: string }>
}

/** Parameters as they are declared for one model. */
export interface StudioModelSurface {
  alias: string
  id: string
  kind: 'image' | 'video'
  aspectRatios: string[]
  resolutions: string[]
  durations: number[]
  maxRefImages: number
  priceNote?: string
  fields: StudioParamField[]
}

/** Poll response: the task plus its current view. */
export interface StudioTaskResponse {
  ok: true
  task: StudioTaskView
}
