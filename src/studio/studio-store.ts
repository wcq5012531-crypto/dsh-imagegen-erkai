/**
 * dsh-imagegen-studio — persisted studio state.
 *
 * Three things live here: the user's protocol adapters, the continuation
 * defaults, and the replication defaults. They are kept out of the plugin
 * settings document on purpose — adapters carry credentials, and the settings
 * document is mirrored to the browser (masked) on every panel render, whereas
 * this file never leaves the host.
 *
 * The file is small enough to be rewritten whole on every change, which removes
 * a whole class of merge bugs at the cost of one write per save.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

import { imageDataRoot } from '../image-storage-path.ts'
import type { AdapterProfile } from './adapter-spec.ts'

/** Defaults for the one-click continuation surface. */
export interface ContinuumDefaults {
  chunkSeconds: number
  overlapFrames: number
  maxSegments: number
  /** Resolution tiers offered by the continuation form. */
  resolutions: string[]
  aspectRatios: string[]
}

/** Defaults for the one-click replication surface. */
export interface ReplicateDefaults {
  /** Shots the analyser aims for when the reference is long. */
  shots: number
  /** Whether to chain shots by first frame (continuity) or render them free. */
  chainFrames: boolean
  /** Extra instruction prepended to every shot prompt. */
  styleBrief: string
}

/** The whole persisted document. */
export interface StudioState {
  version: 1
  adapters: AdapterProfile[]
  continuum: ContinuumDefaults
  replicate: ReplicateDefaults
  /** Last time the document was written (ms epoch). */
  updatedAt?: number
}

export const STUDIO_DEFAULT_CONTINUUM: ContinuumDefaults = {
  chunkSeconds: 5,
  overlapFrames: 22,
  maxSegments: 16,
  resolutions: ['480P', '720P', '1080P'],
  aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
}

export const STUDIO_DEFAULT_REPLICATE: ReplicateDefaults = {
  shots: 4,
  chainFrames: true,
  styleBrief: '',
}

/** Directory holding the studio document. */
export function studioDir(): string {
  return path.join(imageDataRoot(), 'studio')
}

/** Path of the studio document. */
export function studioStatePath(): string {
  return path.join(studioDir(), 'state.json')
}

/** Coerce anything read from disk into a usable document. */
function normalize(raw: unknown): StudioState {
  const record = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const adapters = Array.isArray(record.adapters)
    ? record.adapters.filter((item): item is AdapterProfile => {
      if (item === null || typeof item !== 'object') return false
      const adapter = item as Record<string, unknown>
      return typeof adapter.id === 'string' && typeof adapter.baseUrl === 'string' && Array.isArray(adapter.models)
    })
    : []
  const continuum = record.continuum !== null && typeof record.continuum === 'object'
    ? { ...STUDIO_DEFAULT_CONTINUUM, ...record.continuum as Partial<ContinuumDefaults> }
    : { ...STUDIO_DEFAULT_CONTINUUM }
  const replicate = record.replicate !== null && typeof record.replicate === 'object'
    ? { ...STUDIO_DEFAULT_REPLICATE, ...record.replicate as Partial<ReplicateDefaults> }
    : { ...STUDIO_DEFAULT_REPLICATE }
  return {
    version: 1,
    adapters,
    continuum,
    replicate,
    ...typeof record.updatedAt === 'number' ? { updatedAt: record.updatedAt } : {},
  }
}

/** Read the document, returning defaults when it does not exist yet. */
export async function readStudioState(): Promise<StudioState> {
  try {
    const text = await fs.readFile(studioStatePath(), 'utf8')
    return normalize(JSON.parse(text) as unknown)
  } catch {
    return normalize(undefined)
  }
}

/** Write the document atomically (temp file + rename). */
export async function writeStudioState(state: StudioState): Promise<StudioState> {
  const next: StudioState = { ...state, version: 1, updatedAt: Date.now() }
  await fs.mkdir(studioDir(), { recursive: true })
  const target = studioStatePath()
  const temp = `${target}.${process.pid}.tmp`
  await fs.writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(temp, target)
  return next
}

/** Insert or replace one adapter, preserving array order for existing ids. */
export async function saveAdapter(adapter: AdapterProfile): Promise<StudioState> {
  const state = await readStudioState()
  const now = Date.now()
  const existing = state.adapters.find(item => item.id === adapter.id)
  const merged: AdapterProfile = {
    ...adapter,
    createdAt: existing?.createdAt ?? adapter.createdAt ?? now,
    updatedAt: now,
  }
  // An empty token on save means "keep the stored one": the browser only ever
  // sees a mask, so a round-trip through the editor must not wipe the secret.
  if (merged.auth.token.trim() === '' && existing !== undefined) {
    merged.auth = { ...merged.auth, token: existing.auth.token }
  } else if (existing !== undefined && merged.auth.token === existing.auth.token) {
    // unchanged
  } else if (existing !== undefined && /^.{1,8}\*\*\*/.test(merged.auth.token)) {
    merged.auth = { ...merged.auth, token: existing.auth.token }
  }
  const adapters = existing === undefined
    ? [...state.adapters, merged]
    : state.adapters.map(item => item.id === merged.id ? merged : item)
  return writeStudioState({ ...state, adapters })
}

/** Remove one adapter. */
export async function deleteAdapter(id: string): Promise<StudioState> {
  const state = await readStudioState()
  return writeStudioState({ ...state, adapters: state.adapters.filter(item => item.id !== id) })
}

/** Replace the continuation / replication defaults. */
export async function saveStudioDefaults(patch: { continuum?: Partial<ContinuumDefaults>; replicate?: Partial<ReplicateDefaults> }): Promise<StudioState> {
  const state = await readStudioState()
  return writeStudioState({
    ...state,
    continuum: { ...state.continuum, ...patch.continuum ?? {} },
    replicate: { ...state.replicate, ...patch.replicate ?? {} },
  })
}

/** Find one adapter by id. */
export async function findAdapter(id: string): Promise<AdapterProfile | undefined> {
  const state = await readStudioState()
  return state.adapters.find(item => item.id === id)
}
