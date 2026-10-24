/**
 * One-click duration continuation — tail-frame chaining.
 *
 * Every video model caps its clip length (5s, 8s, 10s). "Make it longer" is not
 * a parameter anyone can send, so the only honest way past the cap is to render
 * again and join: take the last frame of the clip you have, hand it to the next
 * render as its first frame, and repeat. That is what ComfyUI-H3-Continuum does
 * with latent overlap inside one sampler; this module does the same thing at the
 * model boundary, which is the only seam a hosted gateway exposes.
 *
 * Two honesty rules are enforced here rather than in the UI:
 *  - the chain is bounded (`segments` and a hard cap), because each segment is a
 *    paid render and an unbounded loop is a way to lose money;
 *  - a segment that fails stops the chain instead of being skipped: a gap in the
 *    middle would produce a clip shorter than the length the user asked for,
 *    silently.
 *
 * The frame grab and the seam are both ffmpeg. When no usable ffmpeg pair is
 * installed the run fails with an actionable message instead of returning a
 * chain of clips with visible jump cuts.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

import { locateFfmpeg } from '../code-render.ts'
import { createClipComposer } from '../clip-compose.ts'
import { imageDataRoot } from '../image-storage-path.ts'
import type { ClipComposer } from '../protocol.ts'
import { runAdapterVideo } from './adapter-engine.ts'
import type { AdapterModelSpec, AdapterProfile } from './adapter-spec.ts'
import type { StudioWireExtras } from './param-schema.ts'

/** Hard cap on rendered segments in one run, regardless of the request. */
export const MAX_CONTINUUM_SEGMENTS = 24

/** Where continuation temporaries live. */
function continuumDir(): string {
  return path.join(imageDataRoot(), 'studio', 'continuum')
}

/** One render request for the continuation chain. */
export interface ContinuumRequest {
  adapter: AdapterProfile
  model: AdapterModelSpec
  /** Prompt for the first new segment. */
  prompt: string
  /** How many segments to render. 1 = one extension of the seed clip. */
  segments: number
  /** Clip length per segment, in seconds. */
  seconds: number
  /**
   * Starting frame as a `data:` URI. Absent means the first segment is rendered
   * text-to-video, which is what "start a long shot from nothing" needs.
   */
  seedFrame?: string
  /**
   * Text appended to the prompt for every subsequent segment, so the shot keeps
   * moving instead of re-rendering the same first frame forever. A model that
   * receives an identical prompt and an identical first frame produces an
   * identical clip, so an empty `promptStep` is legitimate but usually wasteful.
   */
  promptStep?: string
  /** Aspect / resolution / seed forwarded to every segment. */
  aspect?: string
  resolution?: string
  seed?: number
  /** Free-form schema values, applied to every segment. */
  custom?: StudioWireExtras
  /** Crossfade length at every seam, in milliseconds. 0 = hard cut. */
  crossfadeMs?: number
  /** Keep the individual segments in the result (default true). */
  keepSegments?: boolean
}

/** One finished segment. */
export interface ContinuumSegment {
  index: number
  bytes: Buffer
  mime: string
  seconds: number
  prompt: string
}

/** Progress event, for the panel's stage line. */
export interface ContinuumProgress {
  phase: 'render' | 'frame' | 'stitch'
  index: number
  total: number
  message: string
  progress?: number
}

/** A finished chain. */
export interface ContinuumResult {
  segments: ContinuumSegment[]
  /** The joined clip, present when at least two segments exist. */
  stitched?: { bytes: Buffer; mime: string; duration?: number }
  /** Non-fatal notes (missing ffmpeg features, dropped audio, …). */
  warnings: string[]
}

/** Cap on captured ffmpeg output, so a chatty encode cannot grow memory. */
const MAX_PROCESS_OUTPUT = 256 * 1024

/** Frames grabbed from the tail of a clip, tried in order. */
const TAIL_SEEKS = ['-0.5', '-1.5', '-0.1'] as const

/**
 * Run one ffmpeg invocation and collect its stderr.
 * @param command - ffmpeg path.
 * @param args - arguments.
 * @param options - timeout and cancellation.
 * @returns captured stderr, for the failure message.
 */
function runFfmpeg(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false
    let stderr = ''
    const child = spawn(command, [...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('取帧超时'))
    }, options.timeoutMs)
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish(new Error('已取消'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) reject(error)
      else resolve(stderr)
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_PROCESS_OUTPUT) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: Error) => { finish(error) })
    child.on('close', (code: number | null) => {
      if (code === 0) finish()
      else finish(new Error(`ffmpeg 退出码 ${String(code)}：${stderr.slice(-800)}`))
    })
  })
}

/**
 * Grab the last frame of a clip as a PNG data URI.
 *
 * Three seeks are tried because `-sseof` lands on a keyframe boundary: on a clip
 * whose last keyframe sits more than half a second from the end, the first seek
 * yields no frame at all ("Output file is empty"). The progressively larger
 * seeks always find one, and the frame closest to the end is preferred.
 * @param bytes - the clip.
 * @param mime - its container MIME, used to pick a file extension.
 * @param dir - scratch directory.
 * @param options - cancellation.
 * @returns the frame as `data:image/png;base64,…`.
 */
export async function grabTailFrame(
  bytes: Buffer,
  mime: string,
  dir: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const ffmpeg = locateFfmpeg()
  if (ffmpeg === undefined) {
    throw new Error('续时长需要本机 ffmpeg：取尾帧与拼接收尾都依赖它；安装 ffmpeg 后重试')
  }
  await fs.mkdir(dir, { recursive: true })
  const stem = `tail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const input = path.join(dir, `${stem}.${mime.includes('webm') ? 'webm' : 'mp4'}`)
  const output = path.join(dir, `${stem}.png`)
  await fs.writeFile(input, bytes)
  let lastError: Error | undefined
  try {
    for (const seek of TAIL_SEEKS) {
      if (options.signal?.aborted === true) throw new Error('已取消')
      try {
        await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-sseof', seek, '-i', input, '-frames:v', '1', '-update', '1', output], {
          timeoutMs: 60_000,
          ...options.signal === undefined ? {} : { signal: options.signal },
        })
        const frame = await fs.readFile(output)
        if (frame.byteLength > 0) return `data:image/png;base64,${frame.toString('base64')}`
        lastError = new Error('取到的尾帧是空文件')
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    throw lastError ?? new Error('取尾帧失败')
  } finally {
    await fs.rm(input, { force: true }).catch(() => {})
    await fs.rm(output, { force: true }).catch(() => {})
  }
}

/**
 * Render a chain of segments joined by their tail frames.
 * @param request - the chain description.
 * @param options - progress, cancellation, and an injectable composer.
 * @returns the segments plus the stitched clip when two or more exist.
 */
export async function runContinuum(
  request: ContinuumRequest,
  options: { signal?: AbortSignal; onProgress?: (event: ContinuumProgress) => void; composer?: ClipComposer } = {},
): Promise<ContinuumResult> {
  const total = Math.max(1, Math.min(MAX_CONTINUUM_SEGMENTS, Math.floor(request.segments)))
  const warnings: string[] = []
  const segments: ContinuumSegment[] = []
  const dir = continuumDir()
  await fs.mkdir(dir, { recursive: true })

  let frame = request.seedFrame
  for (let index = 0; index < total; index++) {
    if (options.signal?.aborted === true) throw new Error('已取消')
    const prompt = index === 0 || request.promptStep === undefined || request.promptStep.trim() === ''
      ? request.prompt
      : `${request.prompt}，${request.promptStep.trim()}`
    options.onProgress?.({ phase: 'render', index: index + 1, total, message: `渲染第 ${index + 1}/${total} 段`, progress: index / total })
    const result = await runAdapterVideo(request.adapter, request.model, {
      prompt,
      model: request.model.id,
      ...request.aspect === undefined ? {} : { aspect: request.aspect },
      ...request.resolution === undefined ? {} : { resolution: request.resolution },
      ...request.seed === undefined ? {} : { seed: request.seed },
      duration: request.seconds,
      n: 1,
      ...frame === undefined ? {} : { firstFrame: frame, images: [frame] },
      ...request.custom === undefined ? {} : { custom: request.custom },
    }, {
      ...options.signal === undefined ? {} : { signal: options.signal },
      onProgress: event => {
        options.onProgress?.({
          phase: 'render',
          index: index + 1,
          total,
          message: `第 ${index + 1}/${total} 段：${event.message}`,
          ...event.progress === undefined ? {} : { progress: (index + event.progress / 100) / total },
        })
      },
    })
    const clip = result.videos[0]
    if (clip === undefined) throw new Error(`第 ${index + 1} 段没有返回视频`)
    segments.push({ index, bytes: clip.bytes, mime: clip.mime, seconds: clip.duration ?? request.seconds, prompt })
    // The next segment starts where this one ended.
    options.onProgress?.({ phase: 'frame', index: index + 1, total, message: '取尾帧作为下一段首帧', progress: (index + 0.9) / total })
    frame = await grabTailFrame(clip.bytes, clip.mime, dir, options.signal === undefined ? {} : { signal: options.signal })
  }

  if (segments.length < 2) {
    return { segments, warnings }
  }

  options.onProgress?.({ phase: 'stitch', index: total, total, message: '拼接并统一编码', progress: 0.96 })
  const composer = options.composer ?? createClipComposer()
  if (!composer.available()) {
    warnings.push(`未找到可用的 ffmpeg/ffprobe（${composer.describe()}）：已逐段返回，未拼接`)
    return { segments, warnings }
  }
  const files: string[] = []
  try {
    for (const segment of segments) {
      const file = path.join(dir, `seg-${Date.now()}-${segment.index}.${segment.mime.includes('webm') ? 'webm' : 'mp4'}`)
      await fs.writeFile(file, segment.bytes)
      files.push(file)
    }
    const crossfadeSeconds = Math.max(0, (request.crossfadeMs ?? 0) / 1000)
    const stitched = await composer.stitch({
      sources: files,
      ...crossfadeSeconds <= 0 ? {} : {
        // A crossfade at every seam hides the tail-frame discontinuity, which is
        // the only artefact tail-frame chaining actually produces.
        transitions: files.slice(1).map(() => ({ kind: 'dissolve' as const, seconds: crossfadeSeconds })),
      },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    return {
      segments,
      stitched: {
        bytes: Buffer.from(stitched.bytes),
        mime: stitched.mime,
        ...stitched.duration === undefined ? {} : { duration: stitched.duration },
      },
      warnings,
    }
  } finally {
    for (const file of files) await fs.rm(file, { force: true }).catch(() => {})
  }
}
