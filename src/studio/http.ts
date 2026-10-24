/**
 * Small HTTP helpers for the studio routes.
 *
 * The plugin's own route table keeps its helpers private, so this module carries
 * its own copies rather than reaching across a 2 500-line file. Same rules: every
 * route is loopback-only, every body is size-capped, and every failure comes back
 * as `{ ok: false, code, message }` with HTTP 200 — the panel renders the message
 * instead of an empty rectangle.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Cap for studio JSON bodies: enough for a couple of reference images. */
export const MAX_STUDIO_BODY_BYTES = 48 * 1024 * 1024

/**
 * Write one JSON response.
 * @param res - the response.
 * @param status - HTTP status.
 * @param body - payload.
 */
export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * True when the request came from this machine.
 *
 * The panel holds the user's credentials, so a route that answers a LAN peer
 * would be a credential oracle even if it never prints the key.
 * @param req - the request.
 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Read a JSON body, refusing anything oversized or unparseable.
 * @param req - the request.
 * @returns the parsed body, or undefined.
 */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_STUDIO_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * Message of an unknown thrown value.
 * @param error - thrown value.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Serve one file with Range support.
 *
 * Range matters here rather than being a nicety: without it a browser cannot seek
 * a generated clip, and the panel's scrubber would jump back to zero on every
 * drag.
 * @param res - the response.
 * @param filePath - absolute file path.
 * @param mime - content type.
 * @param range - the request's Range header, when present.
 */
export async function sendFile(res: ServerResponse, filePath: string, mime: string, range?: string): Promise<void> {
  let size: number
  try {
    size = (await fs.stat(filePath)).size
  } catch {
    writeJson(res, 404, { ok: false, code: 'not-found', message: '文件不存在' })
    return
  }
  const match = range === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  if (match !== null) {
    const startRaw = match[1] ?? ''
    const endRaw = match[2] ?? ''
    let start = startRaw === '' ? NaN : Number(startRaw)
    let end = endRaw === '' ? size - 1 : Number(endRaw)
    if (Number.isNaN(start)) {
      // Suffix range: the last N bytes.
      const suffix = Number(endRaw)
      start = Number.isFinite(suffix) ? Math.max(0, size - suffix) : 0
      end = size - 1
    }
    start = Math.max(0, Math.min(start, size - 1))
    end = Math.max(start, Math.min(end, size - 1))
    const length = end - start + 1
    res.writeHead(206, {
      'content-type': mime,
      'content-length': length,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    })
    createReadStream(filePath, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, {
    'content-type': mime,
    'content-length': size,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  })
  createReadStream(filePath).pipe(res)
}

/**
 * Reject anything that is not a plain file name, so a served asset can never be
 * a path traversal.
 * @param name - candidate name.
 */
export function safeAssetName(name: string): string | undefined {
  const trimmed = name.trim()
  if (trimmed === '' || trimmed.length > 200) return undefined
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return undefined
  if (trimmed.startsWith('.')) return undefined
  return trimmed
}

/**
 * Join a directory and a file name, refusing escapes.
 * @param dir - base directory.
 * @param name - file name.
 */
export function resolveInside(dir: string, name: string): string | undefined {
  const safe = safeAssetName(name)
  if (safe === undefined) return undefined
  const full = path.resolve(dir, safe)
  return full.startsWith(path.resolve(dir) + path.sep) ? full : undefined
}
