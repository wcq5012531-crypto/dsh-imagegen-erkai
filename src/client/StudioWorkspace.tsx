/**
 * Studio workspace: the chat-first generation surface.
 *
 * This is the panel the user asked for, in the position the plain "普通生图" tab
 * used to hold: a conversation on the left, threads on the right, one composer at
 * the bottom. Every model-shaped decision (which knobs exist, what values they
 * accept, how many reference images, how long a clip may be) is read from the
 * adapter profile rather than hard-coded, so adding a gateway or a model is data,
 * not a code change.
 *
 * Two rules shape the code:
 *
 *  - the composer never guesses. A control exists because the model declares it,
 *    and the request is built from the same declaration the host uses, so a
 *    failure can only be the gateway's, not a mismatch between two lists;
 *  - nothing is spent implicitly. A render starts from an explicit press, and the
 *    exact wire request is one click away before and after it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImageGenApi } from './api.ts'
import { openImageGenConfig } from './config-entry.tsx'
import type { StudioParamField } from '../studio/param-schema.ts'
import type { StudioTaskView } from '../studio/tasks.ts'
import {
  adoptModels,
  cancelTask,
  discoverModels,
  listAdapters,
  previewRequest,
  readTask,
  startContinuum,
  startGenerate,
  StudioApiError,
  toDataUri,
} from './studio-api.ts'
import type { StudioDiscoveredModel, StudioGenerateRequest, StudioParamState, StudioPreviewResult } from '../studio/types.ts'
import type { HistoryEntry } from '../protocol.ts'
import { drainStudioInbox, subscribeStudioInbox } from './studio-bridge.ts'
import css from './studio.module.css'

/** One reference material the composer carries. */
interface StudioAttachment {
  name: string
  uri: string
  kind: 'image' | 'video' | 'audio'
}

/** Read any http/data URL into a data URI so it can travel as a reference. */
async function urlToDataUri(url: string): Promise<string> {  if (url.startsWith('data:')) return url
  const response = await fetch(url)
  if (!response.ok) throw new Error(`读取素材失败：HTTP ${String(response.status)}`)
  const blob = await response.blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => { resolve(String(reader.result)) }
    reader.onerror = () => { reject(new Error('读取素材失败')) }
    reader.readAsDataURL(blob)
  })
}

/**
 * `n`（张数）只由内置「数量」chip 提供。字段层若也带同名键，发送前剔掉，
 * 否则两份值在网关那边谁生效取决于字段顺序。
 */
function withoutCountAlias(state: StudioParamState): StudioParamState {
  if (state.n === undefined && state.count === undefined) return state
  const next = { ...state }
  delete next.n
  delete next.count
  return next
}

/**
 * 让当前值一定出现在下拉里：运营在线上清单里改过枚举、或本地还存着旧值时，
 * 原生 select 不会因为值不在 options 里就显示空白。
 */
function mergeOption(current: string, list: readonly string[]): string[] {
  const options = [...list]
  if (current !== '' && !options.includes(current)) options.unshift(current)
  return options
}

/**
 * 参数胶囊的下拉：自己画的列表，不用原生 `<select>`。
 * 原生弹出层由系统绘制，方向和宽度都不受控；portal 方案又要算窗口坐标、还会被
 * 祖先的 transform 带偏。这里用最朴素的做法：菜单是胶囊的绝对定位子元素，
 * 打开时量一次高度决定往上还是往下，一律贴边展开，不依赖任何外部 API。
 */
function PillSelect(props: {
  label: string
  value: string
  options: Array<{ value: string, label: string }>
  onChange: (value: string) => void
  help?: string
}): React.ReactElement {
  const { label, value, options, onChange, help } = props
  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const current = options.find(option => option.value === value)

  const toggle = useCallback((): void => {
    setOpen(current => {
      if (current) return false
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect !== undefined) {
        // 下方放不下整块菜单就往上弹；面板底部那一行因此稳定向上，不会一半看不见。
        const need = Math.min(260, options.length * 28 + 12)
        setDropUp(rect.bottom + need > window.innerHeight - 8)
      }
      return true
    })
  }, [options.length])

  useEffect(() => {
    if (!open) return
    const off = (event: Event): void => {
      const target = event.target as Node | null
      if (target !== null && rootRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', off, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', off, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <span ref={rootRef} className={css.pill} data-open={open ? 'true' : 'false'} title={help ?? label}>
      <span className={css.pillKey}>{label}</span>
      <button
        type="button"
        className={css.pillValue}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className={css.pillText}>{current?.label ?? value}</span>
        <span className={css.pillCaret} />
      </button>
      {!open || options.length === 0
        ? null
        : (
          <span className={css.pillMenu} role="listbox" data-drop={dropUp ? 'up' : 'down'}>
            {options.map(option => (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={css.pillItem}
                data-on={option.value === value ? 'true' : 'false'}
                onClick={() => { onChange(option.value); setOpen(false) }}
              >{option.label}</button>
            ))}
          </span>
        )}
    </span>
  )
}

/**
 * 有内置胶囊控件的参数：字段层不许再声明一遍。
 * `role` 是预设表里的语义标签，`key` 是网关真实字段名，两种都得挡。
 */
const RESERVED_ROLES = new Set(['duration', 'aspect', 'resolution', 'n', 'count', 'size'])
const RESERVED_KEYS = new Set([
  'duration', 'seconds', 'second', 'aspect', 'aspect_ratio', 'aspectRatio',
  'resolution', 'size', 'n', 'count', 'num_images', 'numImages', 'batch_size',
])

/** The ＋素材 menu — the same five sources the infinite canvas offers. */
const SOURCE_MENU: { key: 'upload' | 'gallery' | 'history' | 'generate' | 'video'; label: string }[] = [
  { key: 'upload', label: '本地图片' },
  { key: 'gallery', label: '素材库' },
  { key: 'history', label: '历史记录' },
  { key: 'generate', label: 'AI 生成' },
  { key: 'video', label: '添加视频' },
]

/** One masked adapter as it arrives from the host. */
interface AdapterView {
  id: string
  label: string
  kind: 'image' | 'video'
  baseUrl: string
  auth: { style: string; masked: string; hasToken: boolean; headerName?: string; queryName?: string; prefix?: string; token?: string }
  submit: { method: string; path: string; contentType?: string; bodyTemplate?: string; headers?: Record<string, string> }
  poll?: { path: string; taskIdPath: string; statusPath?: string; progressPath?: string; errorPath?: string; intervalMs?: number; timeoutMs?: number }
  result: { urlPaths?: string[]; b64Paths?: string[]; mimePath?: string; revisedPromptPath?: string }
  fields?: Record<string, string>
  models: {
    alias: string
    id: string
    aspectRatios?: string[]
    resolutions?: string[]
    durations?: number[]
    maxRefImages?: number
    extra?: Record<string, unknown>
    fieldOverrides?: Record<string, string>
    params?: StudioParamField[]
    priceNote?: string
  }[]
  note?: string
}

/** One media asset shown in a turn. */
interface TurnAsset {
  url: string
  mime: string
  duration?: number
}

/** One chat turn. */
interface Turn {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: number
  images?: TurnAsset[]
  video?: TurnAsset
  segments?: TurnAsset[]
  taskId?: string
  state?: 'running' | 'done' | 'error' | 'cancelled'
  phase?: string
  progress?: number
  warnings?: string[]
  error?: string
  /** Settings this turn was rendered with, so "再试一次" repeats exactly. */
  meta?: string
  /** Prompt and model label carried onto the result turn so a finished image
   *  can be written into the asset library without a second lookup. */
  prompt?: string
  modelLabel?: string
  /** Asset-library ids already written for this turn, keyed by image index. */
  saved?: string[]
}

/** Where the studio remembers "write finished images into the library". */
const AUTO_LIBRARY_KEY = 'dsh-imagegen-studio:studio-auto-library'

/** Read the persisted 自动入库 switch (defaults to on). */
function loadAutoLibrary(): boolean {
  try {
    return window.localStorage.getItem(AUTO_LIBRARY_KEY) !== 'off'
  } catch {
    return true
  }
}

/** Base64 payload of one blob, without the `data:` prefix. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      const comma = text.indexOf(',')
      resolve(comma >= 0 ? text.slice(comma + 1) : '')
    }
    reader.onerror = () => { reject(new Error('读取生成结果失败')) }
    reader.readAsDataURL(blob)
  })
}

/** One persisted thread. */
interface Thread {
  id: string
  title: string
  at: number
  turns: Turn[]
}

const THREADS_KEY = 'dsh-imagegen-studio:studio-threads'
const ACTIVE_KEY = 'dsh-imagegen-studio:studio-active-thread'
const SELECTION_KEY = 'dsh-imagegen-studio:studio-selection'

/** Fresh id, unique enough for a local list. */
function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Read persisted threads, tolerating a corrupt or absent key. */
function loadThreads(): Thread[] {
  try {
    const raw = window.localStorage.getItem(THREADS_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is Thread => {
      if (entry === null || typeof entry !== 'object') return false
      const record = entry as Record<string, unknown>
      return typeof record.id === 'string' && Array.isArray(record.turns)
    }).slice(0, 50)
  } catch {
    return []
  }
}

/** Persist threads, ignoring quota failures (a long history is not fatal). */
function saveThreads(threads: Thread[]): void {
  try {
    window.localStorage.setItem(THREADS_KEY, JSON.stringify(threads.slice(0, 50)))
  } catch {
    // Quota exhausted: the visible session keeps working, only reload loses history.
  }
}

/** Persist the current selection so the panel reopens where it was left. */
function saveSelection(value: { adapterId: string; alias: string }): void {
  try {
    window.localStorage.setItem(SELECTION_KEY, JSON.stringify(value))
  } catch {
    // Non-fatal.
  }
}

/** Read the persisted selection. */
function loadSelection(): { adapterId: string; alias: string } {
  try {
    const raw = window.localStorage.getItem(SELECTION_KEY)
    if (raw === null) return { adapterId: '', alias: '' }
    const parsed = JSON.parse(raw) as { adapterId?: unknown; alias?: unknown }
    return {
      adapterId: typeof parsed.adapterId === 'string' ? parsed.adapterId : '',
      alias: typeof parsed.alias === 'string' ? parsed.alias : '',
    }
  } catch {
    return { adapterId: '', alias: '' }
  }
}

/** Human text for a task state. */
function stateLabel(task: StudioTaskView): string {
  if (task.state === 'done') return '完成'
  if (task.state === 'error') return '失败'
  if (task.state === 'cancelled') return '已取消'
  return task.phase
}

/** Total seconds of a segmented clip. */
function totalSeconds(segments: TurnAsset[] | undefined): number {
  return (segments ?? []).reduce((sum, segment) => sum + (segment.duration ?? 0), 0)
}

/** Props accepted by the workspace. */
export interface StudioWorkspaceProps {
  /** True while this workspace is the visible one; pauses polling when false. */
  active: boolean
}

/**
 * The chat-first workspace.
 * @param props - visibility flag.
 */
export function StudioWorkspace({ active }: StudioWorkspaceProps): React.ReactElement {
  const [adapters, setAdapters] = useState<AdapterView[]>([])
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [threads, setThreads] = useState<Thread[]>(() => {
    const stored = loadThreads()
    return stored.length > 0 ? stored : [{ id: newId(), title: '新对话', at: Date.now(), turns: [] }]
  })
  const [activeThreadId, setActiveThreadId] = useState<string>(() => {
    try {
      return window.localStorage.getItem(ACTIVE_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const initial = loadSelection()
  const [adapterId, setAdapterId] = useState(initial.adapterId)
  const [alias, setAlias] = useState(initial.alias)
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<StudioAttachment[]>([])
  /**
   * 画布 → 普通生图 的直连：画布右键「送到普通生图」把媒体放进那条小队列，
   * 这里一进来就取走，转成 data URI 挂到参考素材位。
   */
  useEffect(() => {
    const consume = (): void => {
      const inbox = drainStudioInbox()
      if (inbox.length === 0) return
      void Promise.all(inbox.map(async item => ({
        name: item.name ?? (item.kind === 'video' ? '画布视频' : '画布图片'),
        kind: item.kind,
        uri: item.url.startsWith('data:') ? item.url : await urlToDataUri(item.url),
      }))).then(prepared => {
        setAttachments(current => [...current, ...prepared].slice(-12))
      }).catch(() => { /* 取不到就当作没送过来 */ })
    }
    consume()
    return subscribeStudioInbox(consume)
  }, [])
  const [aspect, setAspect] = useState('')
  const [resolution, setResolution] = useState('')
  const [duration, setDuration] = useState<number | undefined>(undefined)
  const [count, setCount] = useState<number>(1)
  const [seed, setSeed] = useState('')
  const [negative, setNegative] = useState('')
  const [params, setParams] = useState<StudioParamState>({})
  const [toolsOpen, setToolsOpen] = useState(false)
  /** 点哪个 chip，就在下面就地展开哪一行的选项（和素材区一样的位置）。 */
  const [pick, setPick] = useState<string | undefined>(undefined)
  /** ＋素材 的五个来源：和无限画布同一套（本地/素材库/历史/AI 生成/视频）。 */
  const [sourceMenu, setSourceMenu] = useState<{ left: number; top: number } | undefined>(undefined)
  const [sourceTab, setSourceTab] = useState<'gallery' | 'history' | 'generate' | undefined>(undefined)
  const [sourceItems, setSourceItems] = useState<{ key: string; url: string; label: string }[] | undefined>(undefined)
  const [sourceChosen, setSourceChosen] = useState<string[]>([])
  const [sourcePrompt, setSourcePrompt] = useState('')
  const [sourceCount, setSourceCount] = useState(1)
  const [sourceBusy, setSourceBusy] = useState(false)
  const sourceButton = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const videoInput = useRef<HTMLInputElement | null>(null)

  /**
   * 参数行的选项表。每个 chip 对应一组选项，点开时下面展开一排 pill，
   * 选完即收起——不做浮层、不另起一行常驻。
   */
  const buildPicker = (): { label: string; items: { key: string; label: string; on: boolean; apply: () => void }[] } | undefined => {
    const close = (): void => { setPick(undefined) }
    if (pick === 'duration') {
      return {
        label: '时长',
        items: (model?.durations ?? []).map(value => ({
          key: String(value),
          label: `${String(value)}s`,
          on: duration === value,
          apply: () => { setDuration(value); close() },
        })),
      }
    }
    if (pick === 'resolution') {
      return {
        label: '清晰度',
        items: (model?.resolutions ?? []).map(value => ({
          key: value,
          label: value,
          on: resolution === value,
          apply: () => { setResolution(value); close() },
        })),
      }
    }
    if (pick === 'aspect') {
      return {
        label: '画幅',
        items: (model?.aspectRatios ?? []).map(value => ({
          key: value,
          label: value,
          on: aspect === value,
          apply: () => { setAspect(value); close() },
        })),
      }
    }
    if (pick === 'count') {
      return {
        label: '数量',
        items: [1, 2, 3, 4].map(value => ({
          key: String(value),
          label: `${String(value)} 张`,
          on: count === value,
          apply: () => { setCount(value); close() },
        })),
      }
    }
    return undefined
  }

  /** 底下一行能力提示：这个模型到底接受什么，不用点开也知道。 */
  const buildCapsLine = (): string => {
    const parts: string[] = []
    if ((model?.durations ?? []).length > 0) {
      const list = model?.durations ?? []
      parts.push(list.length === 1 ? `${String(list[0])}s` : `${String(list[0])}–${String(list[list.length - 1])}s`)
    }
    if ((model?.resolutions ?? []).length > 0) parts.push((model?.resolutions ?? []).join(' / '))
    if ((model?.aspectRatios ?? []).length > 0) parts.push((model?.aspectRatios ?? []).join(' / '))
    const images = model?.maxRefImages ?? 0
    parts.push(`${String(attachments.length)} 素材`)
    parts.push(images === 0 ? '不支持参考图' : `最多 ${String(images)} 张参考图`)
    return parts.join(' · ')
  }

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string; warnings?: string[] } | undefined>(undefined)
  const [preview, setPreview] = useState<StudioPreviewResult | undefined>(undefined)
  const [discovered, setDiscovered] = useState<StudioDiscoveredModel[] | undefined>(undefined)
  const [continuumOpen, setContinuumOpen] = useState(false)
  const [continuumSegments, setContinuumSegments] = useState(2)
  const [continuumFade, setContinuumFade] = useState(0)
  /** Finished renders are written into the asset library by default, which is
   *  what makes 普通生图 → 素材库 → 无限画布 one continuous flow. */
  const [autoLibrary, setAutoLibrary] = useState<boolean>(loadAutoLibrary)
  const [savingKey, setSavingKey] = useState<string | undefined>(undefined)
  const libraryApi = useMemo(() => new ImageGenApi(), [])
  const fileInput = useRef<HTMLInputElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  const adapter = useMemo(() => adapters.find(entry => entry.id === adapterId) ?? adapters[0], [adapters, adapterId])
  const model = useMemo(() => adapter?.models.find(entry => entry.alias === alias) ?? adapter?.models[0], [adapter, alias])
  const thread = useMemo(() => threads.find(entry => entry.id === activeThreadId) ?? threads[0], [threads, activeThreadId])

  /** 素材按类型分开：图/视频/音频各走请求里对应的数组。 */
  const referenceImages = useMemo(() => attachments.filter(item => item.kind === 'image'), [attachments])
  const referenceVideos = useMemo(() => attachments.filter(item => item.kind === 'video'), [attachments])
  const referenceAudios = useMemo(() => attachments.filter(item => item.kind === 'audio'), [attachments])

  /** The surface an adapter/model pair implies. */
  const surface: 'image' | 'edit' | 'video' = adapter?.kind === 'video'
    ? 'video'
    : (model?.maxRefImages ?? 0) > 0 && referenceImages.length > 0 ? 'edit' : 'image'

  /** Declared controls for the current surface. */
  /**
   * 模型是否自己声明了 `n`。声明了就说明它接受"一次多张"，那颗「数量」chip
   * 必须留着（视频模型默认不显示数量，只有这种情况下才显示）。
   */
  const declaresCount = useMemo(
    () => (model?.params ?? []).some(field => field.role === 'n' || field.key === 'n'),
    [model],
  )

  const declared = useMemo(() => (model?.params ?? []).filter(field => {
    // 时长/画幅/清晰度/数量 都有内置的胶囊控件，字段层再声明一次就会长出第二颗同名
    // 控件（改一个值另一个不动，最容易被当成 bug）。
    if (RESERVED_ROLES.has(field.role ?? '') || RESERVED_KEYS.has(field.key)) return false
    if (field.surfaces !== undefined && !field.surfaces.includes(surface)) return false
    if (field.requires === 'image' && referenceImages.length === 0) return false
    return true
  }), [model, surface, referenceImages.length])

  /**
   * 正在就地编辑的模型私有字段。每颗字段 chip 和时长/画幅/清晰度/数量同一层、
   * 同一行，点开就在下面展开它自己的控件，不做「更多」二级菜单。
   */
  const editingField = useMemo(
    () => declared.find(field => pick === `param:${field.key}`),
    [declared, pick],
  )

  /** chip 正面上显示的当前值，不点开也能看清这一项现在是什么。 */
  const fieldChipText = (field: StudioParamField): string => {
    const label = field.label ?? field.key
    const value = params[field.key]
    if (field.kind === 'enum') {
      const options = field.options ?? []
      const raw = typeof value === 'string' ? value : field.default ?? options[0]?.value
      const hit = options.find(option => String(option.value) === String(raw ?? ''))
      return `${label} ${hit?.label ?? String(raw ?? '默认')}`
    }
    if (field.kind === 'boolean') return `${label} ${value === true ? '开' : '关'}`
    if (field.kind === 'multi') {
      const chosen = Array.isArray(value) ? value.length : 0
      return `${label} ${chosen === 0 ? '未选' : String(chosen)}`
    }
    if (field.kind === 'longtext' || field.kind === 'json') return `${label} ${value === undefined || value === '' ? '空' : '已填'}`
    if (value === undefined || value === '') return `${label} ${field.default === undefined ? '默认' : String(field.default)}`
    return `${label} ${String(value)}`
  }

  /** Load adapters once, then keep the selection coherent. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await listAdapters()
      const list = (response.adapters as AdapterView[]).filter(entry => entry !== null && typeof entry === 'object')
      setAdapters(list)
      setLoadError(undefined)
      if (list.length > 0) {
        setAdapterId(current => current !== '' && list.some(entry => entry.id === current) ? current : list[0]!.id)
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (adapter === undefined) return
    setAlias(current => current !== '' && adapter.models.some(entry => entry.alias === current) ? current : adapter.models[0]?.alias ?? '')
  }, [adapter])

  useEffect(() => {
    if (adapterId !== '' || alias !== '') saveSelection({ adapterId, alias })
  }, [adapterId, alias])

  // The shell sidebar owns the conversation list now, so it talks to this
  // surface through two window events instead of reaching into its state.
  useEffect(() => {
    const onSelect = (event: Event): void => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail
      const target = detail?.threadId
      if (typeof target !== 'string' || target === '') return
      setThreads(current => current.some(entry => entry.id === target)
        ? current
        : [{ id: target, title: '对话', at: Date.now(), turns: [] }, ...current])
      setActiveThreadId(target)
    }
    const onNew = (): void => {
      const fresh: Thread = { id: newId(), title: '新对话', at: Date.now(), turns: [] }
      setThreads(current => [fresh, ...current].slice(0, 50))
      setActiveThreadId(fresh.id)
    }
    const onDelete = (event: Event): void => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail
      const target = detail?.threadId
      if (typeof target !== 'string' || target === '') return
      // Removing the open conversation is safe: `thread` falls back to
      // `threads[0]`, so the composer never lands on a dangling id.
      setThreads(current => current.filter(entry => entry.id !== target))
    }
    window.addEventListener('dsh-imagegen-studio:studio-select', onSelect)
    window.addEventListener('dsh-imagegen-studio:studio-new', onNew)
    window.addEventListener('dsh-imagegen-studio:studio-delete', onDelete)
    return () => {
      window.removeEventListener('dsh-imagegen-studio:studio-select', onSelect)
      window.removeEventListener('dsh-imagegen-studio:studio-new', onNew)
      window.removeEventListener('dsh-imagegen-studio:studio-delete', onDelete)
    }
  }, [])

  useEffect(() => {
    // Typing changes `threads` on every keystroke; serializing up to 50 threads
    // (reference thumbnails included) synchronously each time is what makes the
    // panel feel stuck on a slow machine, so coalesce the writes.
    const timer = window.setTimeout(() => { saveThreads(threads) }, 600)
    return () => { window.clearTimeout(timer) }
  }, [threads])

  // Tell the sidebar list to re-read storage after every turn.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('dsh-imagegen-studio:studio-changed'))
  }, [threads, activeThreadId])
  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_KEY, activeThreadId)
    } catch {
      // Non-fatal.
    }
  }, [activeThreadId])

  /** Clamp the classic knobs to what the model actually offers. */
  useEffect(() => {
    if (model === undefined) return
    setAspect(current => model.aspectRatios === undefined || model.aspectRatios.length === 0 || model.aspectRatios.includes(current) ? current : model.aspectRatios[0]!)
    setResolution(current => model.resolutions === undefined || model.resolutions.length === 0 || model.resolutions.includes(current) ? current : model.resolutions[0]!)
    setDuration(current => model.durations === undefined || model.durations.length === 0 || (current !== undefined && model.durations.includes(current)) ? current : model.durations[0])
  }, [model])

  /** Keep the transcript pinned to the newest turn. */
  useEffect(() => {
    if (!active) return
    const node = scroller.current
    if (node !== null) node.scrollTop = node.scrollHeight
  }, [active, thread?.turns.length, thread?.turns[thread?.turns.length - 1]?.progress])

  /** Replace one turn inside one thread. */
  const patchTurn = useCallback((threadId: string, turnId: string, patch: Partial<Turn>): void => {
    setThreads(current => current.map(entry => entry.id === threadId
      ? { ...entry, turns: entry.turns.map(turn => turn.id === turnId ? { ...turn, ...patch } : turn) }
      : entry))
  }, [])

  /** Copy one finished render into the asset library. The host deduplicates by
   *  content, so the自动 path and a manual press can both fire harmlessly.
   *  @returns true when the library gained a new entry. */
  const saveToLibrary = useCallback(async (image: TurnAsset, prompt: string, modelLabel: string): Promise<boolean> => {
    const response = await fetch(image.url)
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const b64 = await blobToBase64(await response.blob())
    const result = await libraryApi.galleryAppend({
      id: '',
      createdAt: Date.now(),
      mode: 'text',
      model: modelLabel === '' ? 'studio' : modelLabel,
      prompt,
      size: 'auto',
      quality: 'auto',
      detail: '',
      n: 1,
      images: [{ b64, mime: image.mime }],
    })
    if (result.added) window.dispatchEvent(new CustomEvent('dsh-imagegen-studio:gallery-changed'))
    return result.added
  }, [libraryApi])

  /** Write every settled image that the library has not seen yet. The turn
   *  records which indexes are done, so this is idempotent per turn. */
  useEffect(() => {
    if (!autoLibrary) return
    for (const entry of threads) {
      for (const turn of entry.turns) {
        if (turn.role !== 'assistant' || turn.state !== 'done') continue
        if (turn.images === undefined || turn.images.length === 0) continue
        for (const [index, image] of turn.images.entries()) {
          const key = String(index)
          if (turn.saved?.includes(key) === true) continue
          void saveToLibrary(image, turn.prompt ?? turn.text, turn.modelLabel ?? '')
            .then(() => { patchTurn(entry.id, turn.id, { saved: [...(turn.saved ?? []), key] }) })
            .catch(() => undefined)
        }
      }
    }
  }, [autoLibrary, threads, saveToLibrary, patchTurn])

  /** Poll a task until it settles, writing each step into its turn. */
  const watch = useCallback(async (threadId: string, turnId: string, taskId: string): Promise<void> => {
    let stopped = false
    for (let attempt = 0; attempt < 3600 && !stopped; attempt++) {
      await new Promise<void>(resolve => { setTimeout(resolve, 1200) })
      if (!active) {
        // The tab is hidden: keep polling, but slowly, so a background render
        // still lands in the transcript without a busy loop.
        await new Promise<void>(resolve => { setTimeout(resolve, 2400) })
      }
      let task: StudioTaskView
      try {
        task = (await readTask(taskId)).task
      } catch (error) {
        patchTurn(threadId, turnId, { state: 'error', error: error instanceof Error ? error.message : String(error) })
        return
      }
      if (task.state === 'done' && task.result !== undefined) {
        if (task.result.kind === 'image') {
          patchTurn(threadId, turnId, {
            state: 'done',
            phase: '完成',
            progress: 100,
            images: task.result.images.map(image => ({ url: image.url, mime: image.mime })),
          })
        } else {
          patchTurn(threadId, turnId, {
            state: 'done',
            phase: '完成',
            progress: 100,
            video: task.result.video,
            ...task.result.segments === undefined ? {} : { segments: task.result.segments },
            ...task.result.warnings === undefined ? {} : { warnings: task.result.warnings },
          })
        }
        stopped = true
        return
      }
      if (task.state === 'error') {
        patchTurn(threadId, turnId, { state: 'error', error: task.error?.message ?? task.message })
        stopped = true
        return
      }
      if (task.state === 'cancelled') {
        patchTurn(threadId, turnId, { state: 'cancelled', phase: '已取消' })
        stopped = true
        return
      }
      patchTurn(threadId, turnId, {
        state: 'running',
        phase: stateLabel(task),
        ...task.progress === undefined ? {} : { progress: task.progress },
      })
    }
  }, [active, patchTurn])

  /** Build the request body shared by preview and generate. */
  const buildRequest = useCallback((): StudioGenerateRequest | undefined => {
    if (adapter === undefined || model === undefined) return undefined
    return {
      adapterId: adapter.id,
      modelAlias: model.alias,
      surface,
      prompt,
      params: withoutCountAlias(params),
      ...(referenceImages.length === 0 ? {} : { images: referenceImages.map(item => item.uri) }),
      ...(referenceVideos.length === 0 ? {} : { videos: referenceVideos.map(item => item.uri) }),
      ...(referenceAudios.length === 0 ? {} : { audios: referenceAudios.map(item => item.uri) }),
      ...(aspect === '' ? {} : { aspect }),
      ...(resolution === '' ? {} : { resolution }),
      ...(duration === undefined ? {} : { duration }),
      ...(count === 1 ? {} : { n: count }),
      ...(seed.trim() === '' || !Number.isFinite(Number(seed)) ? {} : { seed: Number(seed) }),
      ...(negative.trim() === '' ? {} : { negativePrompt: negative }),
    }
  }, [adapter, model, surface, prompt, params, referenceImages, referenceVideos, referenceAudios, aspect, resolution, duration, count, seed, negative])

  /** Send the composer as one turn. */
  const send = useCallback(async (): Promise<void> => {
    const request = buildRequest()
    if (request === undefined) {
      setNotice({ kind: 'error', text: '先选一个通道和模型' })
      return
    }
    if (request.prompt.trim() === '') {
      setNotice({ kind: 'error', text: '先写点提示词' })
      return
    }
    const threadId = thread?.id ?? ''
    if (threadId === '') return
    const userTurn: Turn = {
      id: newId(),
      role: 'user',
      at: Date.now(),
      text: request.prompt,
      ...(referenceImages.length === 0 ? {} : { images: referenceImages.map(item => ({ url: item.uri, mime: 'image/*' })) }),
      meta: `${adapter?.label ?? ''} · ${model?.alias ?? ''}${duration === undefined ? '' : ` · ${String(duration)}s`}${aspect === '' ? '' : ` · ${aspect}`}`,
    }
    const assistantTurn: Turn = {
      id: newId(),
      role: 'assistant',
      at: Date.now(),
      text: '',
      state: 'running',
      phase: '提交',
      prompt: request.prompt,
      modelLabel: [adapter?.label ?? '', model?.alias ?? ''].filter(part => part !== '').join(' · '),
    }
    setThreads(current => current.map(entry => entry.id === threadId
      ? {
        ...entry,
        title: entry.turns.length === 0 ? request.prompt.slice(0, 24) : entry.title,
        turns: [...entry.turns, userTurn, assistantTurn],
      }
      : entry))
    setPrompt('')
    setAttachments([])
    setBusy(true)
    setNotice(undefined)
    try {
      const started = await startGenerate(request)
      patchTurn(threadId, assistantTurn.id, { taskId: started.taskId })
      void watch(threadId, assistantTurn.id, started.taskId).finally(() => { setBusy(false) })
    } catch (error) {
      const message = error instanceof StudioApiError ? error.message : error instanceof Error ? error.message : String(error)
      patchTurn(threadId, assistantTurn.id, { state: 'error', error: message })
      setNotice({ kind: 'error', text: message })
      setBusy(false)
    }
  }, [buildRequest, thread?.id, referenceImages, adapter, model, duration, aspect, patchTurn, watch])

  /** Continue the newest clip of this thread by chaining tail frames. */
  const continueClip = useCallback(async (): Promise<void> => {
    if (adapter === undefined || model === undefined || thread === undefined) return
    const lastVideo = [...thread.turns].reverse().find(turn => turn.video !== undefined)?.video
    if (lastVideo === undefined) {
      setNotice({ kind: 'error', text: '这个对话里还没有视频可以续' })
      return
    }
    const threadId = thread.id
    const assistantTurn: Turn = { id: newId(), role: 'assistant', at: Date.now(), text: '', state: 'running', phase: '准备' }
    setThreads(current => current.map(entry => entry.id === threadId
      ? {
        ...entry,
        turns: [...entry.turns, {
          id: newId(),
          role: 'user',
          at: Date.now(),
          text: `继续 ${String(continuumSegments)} 段（${continuumFade > 0 ? '淡入淡出' : '硬切'}）`,
          meta: '续时长',
        }, assistantTurn],
      }
      : entry))
    setBusy(true)
    setContinuumOpen(false)
    try {
      const started = await startContinuum({
        adapterId: adapter.id,
        modelAlias: model.alias,
        prompt: prompt.trim() === '' ? '延续上一个镜头，动作与镜头语言保持连贯' : prompt,
        segments: continuumSegments,
        seconds: duration ?? model.durations?.[0] ?? 5,
        seedFromUrl: lastVideo.url,
        ...(aspect === '' ? {} : { aspect }),
        ...(resolution === '' ? {} : { resolution }),
        ...(params === undefined ? {} : { params }),
        crossfadeMs: continuumFade,
      })
      patchTurn(threadId, assistantTurn.id, { taskId: started.taskId })
      void watch(threadId, assistantTurn.id, started.taskId).finally(() => { setBusy(false) })
    } catch (error) {
      patchTurn(threadId, assistantTurn.id, { state: 'error', error: error instanceof Error ? error.message : String(error) })
      setBusy(false)
    }
  }, [adapter, model, thread, prompt, continuumSegments, continuumFade, duration, aspect, resolution, params, patchTurn, watch])

  /** Show the exact request that would be sent. */
  const showPreview = useCallback(async (): Promise<void> => {
    const request = buildRequest()
    if (request === undefined) return
    try {
      setPreview(await previewRequest({ ...request, prompt: request.prompt === '' ? 'preview' : request.prompt }))
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [buildRequest])

  /** Ask the gateway what models it has, and add the missing ones. */
  const discover = useCallback(async (): Promise<void> => {
    if (adapter === undefined) return
    try {
      const result = await discoverModels({ adapterId: adapter.id })
      setDiscovered(result.models)
      if (!result.ok) setNotice({ kind: 'error', text: result.message ?? '发现失败' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [adapter])

  /** Append one discovered model to the channel catalogue and select it. */
  const adoptModel = useCallback(async (entry: StudioDiscoveredModel): Promise<void> => {
    if (adapter === undefined) return
    try {
      // The channel owns the catalogue: a model that only lived in this
      // profile would disappear the next time the channels are read.
      const result = await adoptModels({ adapterId: adapter.id, models: [{ alias: entry.alias, id: entry.id }] })
      await refresh()
      setAlias(entry.alias)
      setDiscovered(current => (current ?? []).map(item => item.id === entry.id ? { ...item, known: true } : item))
      if (result.added === 0) setNotice({ kind: 'info', text: '这个模型已经在渠道目录里了' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }, [adapter, refresh])

  /** Kill the running render of a turn. */
  const stop = useCallback(async (turn: Turn): Promise<void> => {
    if (turn.taskId === undefined) return
    await cancelTask(turn.taskId).catch(() => {})
  }, [])

  /** Update one declared parameter. */
  const setParam = useCallback((key: string, value: unknown): void => {
    setParams(current => ({ ...current, [key]: value }))
  }, [])

  /** Render one declared control. */
  const renderField = (field: StudioParamField): React.ReactElement => {
    const value = params[field.key]
    const label = field.label ?? field.key
    if (field.kind === 'enum') {
      return (
        <label className={css.field} key={field.key}>
          <span>{label}</span>
          <select value={typeof value === 'string' ? value : ''} onChange={event => { setParam(field.key, event.target.value) }}>
            {field.options?.map(option => <option key={String(option.value)} value={String(option.value)}>{option.label ?? String(option.value)}</option>)}
          </select>
        </label>
      )
    }
    if (field.kind === 'multi') {
      const chosen = Array.isArray(value) ? value.map(String) : []
      return (
        <div className={css.field} key={field.key}>
          <span>{label}</span>
          <div className={css.multi}>
            {field.options?.map(option => {
              const token = String(option.value)
              return (
                <label key={token} className={css.multiItem}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(token)}
                    onChange={event => {
                      setParam(field.key, event.target.checked ? [...chosen, token] : chosen.filter(item => item !== token))
                    }}
                  />
                  {option.label ?? token}
                </label>
              )
            })}
          </div>
        </div>
      )
    }
    if (field.kind === 'boolean') {
      return (
        <label className={css.field} key={field.key}>
          <span>{label}</span>
          <input type="checkbox" checked={value === true} onChange={event => { setParam(field.key, event.target.checked) }} />
        </label>
      )
    }
    if (field.kind === 'number') {
      return (
        <label className={css.field} key={field.key}>
          <span>{label}</span>
          <input
            type="number"
            value={typeof value === 'number' ? String(value) : typeof value === 'string' ? value : ''}
            step="any"
            min={field.min === undefined ? undefined : field.min}
            max={field.max === undefined ? undefined : field.max}
            onChange={event => { setParam(field.key, event.target.value === '' ? undefined : Number(event.target.value)) }}
          />
        </label>
      )
    }
    if (field.kind === 'longtext' || field.kind === 'json') {
      return (
        <label className={css.field} key={field.key}>
          <span>{label}</span>
          <textarea
            rows={3}
            value={typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)}
            placeholder={field.placeholder ?? ''}
            onChange={event => { setParam(field.key, event.target.value) }}
          />
        </label>
      )
    }
    return (
      <label className={css.field} key={field.key}>
        <span>{label}</span>
        <input
          type="text"
          value={typeof value === 'string' ? value : value === undefined ? '' : String(value)}
          placeholder={field.placeholder ?? ''}
          onChange={event => { setParam(field.key, event.target.value) }}
        />
      </label>
    )
  }

  /** Attach files as reference material (image, video or audio — by mime). */
  const attach = useCallback(async (files: FileList | null): Promise<void> => {
    if (files === null) return
    const next: StudioAttachment[] = []
    for (const file of Array.from(files).slice(0, 16)) {
      const kind: StudioAttachment['kind'] = file.type.startsWith('image/')
        ? 'image'
        : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'image'
      const decided: StudioAttachment['kind'] = file.type === '' ? 'image' : kind
      const uri = await toDataUri(file)
      if (uri !== '') next.push({ name: file.name, uri, kind: decided })
    }
    setAttachments(current => {
      const images = [...current.filter(item => item.kind === 'image'), ...next.filter(item => item.kind === 'image')].slice(0, model?.maxRefImages ?? 4)
      const videos = [...current.filter(item => item.kind === 'video'), ...next.filter(item => item.kind === 'video')].slice(0, 2)
      const audios = [...current.filter(item => item.kind === 'audio'), ...next.filter(item => item.kind === 'audio')].slice(0, 1)
      return [...images, ...videos, ...audios]
    })
  }, [model])

  /** 本地图片 / 添加视频 → 系统文件框，按类型给 accept。 */
  const pickLocal = (kind: 'image' | 'video'): void => {
    setSourceMenu(undefined)
    if (kind === 'video') { videoInput.current?.click(); return }
    fileInput.current?.click()
  }

  /** 打开 ＋素材 的来源菜单（贴在按钮上方，和画布同一套五项）。 */
  const openSourceMenu = (): void => {
    if (sourceMenu !== undefined) { setSourceMenu(undefined); return }
    const rect = sourceButton.current?.getBoundingClientRect()
    setSourceMenu({ left: rect?.left ?? 40, top: (rect?.top ?? 240) - 8 })
  }

  /**
   * 菜单和弹窗都得能被"点别处"关掉：外面点一下、按 Esc 都算。
   * 捕获阶段挂监听，避免被宿主面板自己的事件吞掉。
   */
  useEffect(() => {
    if (sourceMenu === undefined) return
    const close = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && menuRef.current?.contains(target) === true) return
      if (target instanceof Node && sourceButton.current?.contains(target) === true) return
      setSourceMenu(undefined)
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') setSourceMenu(undefined) }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [sourceMenu])

  useEffect(() => {
    if (sourceTab === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setSourceTab(undefined)
      setSourceItems(undefined)
      setSourceChosen([])
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [sourceTab])

  /** 素材库 / 历史记录：读同一份数据，选完换成 data URI 当参考图。 */
  const loadSourceTab = useCallback(async (tab: 'gallery' | 'history'): Promise<void> => {
    setSourceTab(tab)
    setSourceChosen([])
    setSourceItems(undefined)
    setSourceBusy(true)
    try {
      const entries: HistoryEntry[] = tab === 'gallery'
        ? (await libraryApi.galleryList()).entries
        : await libraryApi.historyList()
      const items = entries.flatMap(entry => entry.images.map((image, index) => ({
        key: `${entry.id}:${String(index)}`,
        url: image.url,
        label: entry.prompt === '' ? entry.model : entry.prompt.slice(0, 40),
      })))
      setSourceItems(items)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSourceBusy(false)
    }
  }, [libraryApi])

  /** 把选中的来源图片加进参考素材。 */
  const attachChosen = async (): Promise<void> => {
    const picked = (sourceItems ?? []).filter(item => sourceChosen.includes(item.key))
    if (picked.length === 0) return
    setSourceBusy(true)
    try {
      const next: StudioAttachment[] = []
      for (const item of picked) next.push({ name: item.label, uri: await urlToDataUri(item.url), kind: 'image' })
      await attachFromList(next)
      setSourceTab(undefined)
      setSourceChosen([])
      setSourceItems(undefined)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSourceBusy(false)
    }
  }

  /** Shared append path for every non-file source. */
  const attachFromList = async (next: StudioAttachment[]): Promise<void> => {
    if (next.length === 0) return
    setAttachments(current => {
      const images = [...current.filter(item => item.kind === 'image'), ...next.filter(item => item.kind === 'image')].slice(0, model?.maxRefImages ?? 4)
      const videos = [...current.filter(item => item.kind === 'video'), ...next.filter(item => item.kind === 'video')].slice(0, 2)
      const audios = [...current.filter(item => item.kind === 'audio'), ...next.filter(item => item.kind === 'audio')].slice(0, 1)
      return [...images, ...videos, ...audios]
    })
    setNotice({ kind: 'info', text: `已加入 ${String(next.length)} 个素材` })
  }

  /** AI 生成一张图，直接变成参考素材（和画布的「AI 生成」同一意图）。 */
  const generateSource = async (): Promise<void> => {
    if (adapter === undefined || model === undefined) return
    if (sourcePrompt.trim() === '') {
      setNotice({ kind: 'error', text: '先写一句想生成的画面' })
      return
    }
    setSourceBusy(true)
    try {
      const request: StudioGenerateRequest = {
        adapterId: adapter.id,
        modelAlias: model.alias,
        surface: 'image',
        prompt: sourcePrompt.trim(),
        params: {},
        ...(aspect === '' ? {} : { aspect }),
        ...(resolution === '' ? {} : { resolution }),
        ...(sourceCount === 1 ? {} : { n: sourceCount }),
      }
      const started = await startGenerate(request)
      const deadline = Date.now() + 5 * 60 * 1000
      let urls: string[] = []
      while (Date.now() < deadline) {
        const task = (await readTask(started.taskId)).task
        if (task.state === 'error') throw new Error(task.error?.message ?? task.message ?? '生成失败')
        if (task.state === 'cancelled') throw new Error('生成已取消')
        if (task.state === 'done' && task.result !== undefined) {
          urls = task.result.kind === 'image' ? task.result.images.map(image => image.url) : []
          break
        }
        await new Promise(resolve => { setTimeout(resolve, 1500) })
      }
      if (urls.length === 0) throw new Error('生成没有返回图片')
      const next: StudioAttachment[] = []
      for (const url of urls) next.push({ name: `AI 生成 ${String(next.length + 1)}`, uri: await urlToDataUri(url), kind: 'image' })
      await attachFromList(next)
      setSourceTab(undefined)
      setSourcePrompt('')
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSourceBusy(false)
    }
  }

  const turns = thread?.turns ?? []
  const canSend = adapter !== undefined && model !== undefined && prompt.trim() !== '' && !busy
  const hasClip = turns.some(turn => turn.video !== undefined)

  if (loadError !== undefined) {
    return (
      <div className={css.root}>
        <div className={css.empty}>
          <strong>实验台路由没有响应</strong>
          <p>{loadError}</p>
          <p>插件重装或 DSH 升级后，需要重启一次会话让路由重新注册。</p>
          <button type="button" onClick={() => { void refresh() }}>重试</button>
        </div>
      </div>
    )
  }

  const picker = buildPicker()
  const capsLine = buildCapsLine()

  return (
    <div className={css.root} data-studio="true">      <div className={css.main}>
        <div className={css.toolbar}>
          {adapter === undefined
            ? null
            : (
              <>
                <span className={`${css.dim} ${css.toolbarNote}`} title={adapter.baseUrl}>
                  {adapter.label}
                </span>
                <span className={css.toolbarSpacer} />
                <button
                  type="button"
                  className={css.ghost}
                  title="打开 设置 → 生图配置：管通道、管每个模型的字段与参数"
                  onClick={() => { openImageGenConfig() }}
                >
                  ⚙ 设置
                </button>
              </>
            )}
        </div>
        <div className={css.log} ref={scroller}>
          {turns.length === 0
            ? (
              <div className={css.hello}>
                <p className={css.dim}>
                  写下画面，Enter 发送。通道、模型、时长、画幅、清晰度、数量和这个模型的私有字段都在底部同一行里，点哪一颗就地改哪一颗。
                </p>
                {adapters.length === 0
                  ? <p className={css.warn}>还没有通道：先在「设置 → 生图配置」里加一个，再填网关地址与 Key。</p>
                  : null}
              </div>
            )
            : turns.map(turn => (
              <article key={turn.id} className={css.turn} data-role={turn.role}>
                {turn.role === 'user'
                  ? (
                    <div className={css.userBubble}>
                      <p>{turn.text}</p>
                      {turn.images === undefined ? null : (
                        <div className={css.attachRow}>
                          {turn.images.map((image, index) => (
                            <img key={`${turn.id}-${String(index)}`} src={image.url} alt="" className={css.attachThumb} />
                          ))}
                        </div>
                      )}
                      {turn.meta === undefined ? null : <span className={css.meta}>{turn.meta}</span>}
                    </div>
                  )
                  : (
                    <div className={css.resultBubble}>
                      {turn.state === 'running'
                        ? (
                          <div className={css.running}>
                            <span className={css.spinner} aria-hidden="true" />
                            <span>{turn.phase ?? '生成中'}</span>
                            {turn.progress === undefined ? null : <progress value={turn.progress} max={100} />}
                            {turn.taskId === undefined ? null : (
                              <button type="button" className={css.ghost} onClick={() => { void stop(turn) }}>取消</button>
                            )}
                          </div>
                        )
                        : null}
                      {turn.state === 'error'
                        ? <p className={css.error}>{turn.error ?? '失败'}</p>
                        : null}
                      {turn.state === 'cancelled' ? <p className={css.dim}>已取消</p> : null}
                      {turn.images === undefined ? null : (
                        <div className={css.imageGrid}>
                          {turn.images.map((image, index) => {
                            const cellKey = `${turn.id}-i${String(index)}`
                            const settled = turn.saved?.includes(String(index)) === true
                            return (
                              <figure key={cellKey} className={css.imageCell}>
                                <a href={image.url} target="_blank" rel="noreferrer">
                                  <img src={image.url} alt="" loading="lazy" />
                                </a>
                                <button
                                  type="button"
                                  className={css.ghost}
                                  disabled={savingKey === cellKey}
                                  onClick={() => {
                                    setSavingKey(cellKey)
                                    void saveToLibrary(image, turn.prompt ?? turn.text, turn.modelLabel ?? '')
                                      .then(added => {
                                        patchTurn(thread?.id ?? '', turn.id, { saved: [...(turn.saved ?? []), String(index)] })
                                        setNotice({ kind: 'info', text: added ? '已加入素材库，画布可以直接调用' : '这张已经在素材库里了' })
                                      })
                                      .catch((error: unknown) => { setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) }) })
                                      .finally(() => { setSavingKey(undefined) })
                                  }}
                                >
                                  {savingKey === cellKey ? '入库中…' : settled ? '已在素材库' : '加入素材库'}
                                </button>
                              </figure>
                            )
                          })}
                        </div>
                      )}
                      {turn.video === undefined ? null : (
                        <div className={css.videoBox}>
                          <video src={turn.video.url} controls playsInline preload="metadata" />
                          <div className={css.videoMeta}>
                            <a href={turn.video.url} target="_blank" rel="noreferrer" download>下载</a>
                            {turn.video.duration === undefined ? null : <span>{turn.video.duration.toFixed(1)}s</span>}
                            {turn.segments === undefined ? null : <span>{String(turn.segments.length)} 段 · {totalSeconds(turn.segments).toFixed(1)}s</span>}
                            {adapter?.kind === 'video' && turn.state === 'done' ? (
                              <button type="button" className={css.ghost} onClick={() => { setContinuumOpen(true) }}>续时长</button>
                            ) : null}
                          </div>
                          {turn.warnings === undefined ? null : (
                            <ul className={css.warnings}>{turn.warnings.map((warning, index) => <li key={`${turn.id}-w${String(index)}`}>{warning}</li>)}</ul>
                          )}
                        </div>
                      )}
                    </div>
                  )}
              </article>
            ))}
        </div>

        <div className={css.composer}>
          {attachments.length === 0 ? null : (
            <div className={css.attachRow}>
              {attachments.map((item, index) => (
                <span key={`${item.name}-${String(index)}`} className={css.attachChip} data-kind={item.kind}>
                  {item.kind === 'video'
                    ? <video src={item.uri} muted playsInline preload="metadata" />
                    : <img src={item.uri} alt="" />}
                  <button type="button" onClick={() => { setAttachments(current => current.filter((_, at) => at !== index)) }}>×</button>
                </span>
              ))}
            </div>
          )}
          <textarea
            className={css.input}
            rows={3}
            value={prompt}
            placeholder="描述你想生成的画面…（Enter 发送，Shift+Enter 换行）"
            onChange={event => { setPrompt(event.target.value) }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                if (canSend) void send()
              }
            }}
          />
          <div className={css.chipBar}>
            <div className={css.chips}>
              <select
              className={css.chipSelect}
              value={adapter?.id ?? ''}
              onChange={event => { setAdapterId(event.target.value); setAlias(''); setPick(undefined) }}
              aria-label="通道"
            >
              {adapters.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
            <select
              className={css.chipSelect}
              value={model?.alias ?? ''}
              onChange={event => { setAlias(event.target.value); setPick(undefined) }}
              aria-label="模型"
            >
              {(adapter?.models ?? []).map(entry => (
                <option key={entry.alias} value={entry.alias}>
                  {entry.alias}{entry.priceNote === undefined ? '' : ` · ${entry.priceNote}`}
                </option>
              ))}
            </select>
            {(model?.durations ?? []).length === 0
              ? null
              : (
                <PillSelect
                  label="时长"
                  value={String(duration ?? model?.durations?.[0] ?? 5)}
                  options={(model?.durations ?? []).map(value => ({ value: String(value), label: `${String(value)}s` }))}
                  onChange={value => { setDuration(Number(value)) }}
                />
              )}
            {(model?.resolutions ?? []).length === 0
              ? null
              : (
                <PillSelect
                  label="清晰度"
                  value={resolution}
                  options={mergeOption(resolution, model?.resolutions ?? []).map(value => ({ value, label: value }))}
                  onChange={setResolution}
                />
              )}
            {(model?.aspectRatios ?? []).length === 0
              ? null
              : (
                <PillSelect
                  label="画幅"
                  value={aspect}
                  options={mergeOption(aspect, model?.aspectRatios ?? []).map(value => ({ value, label: value }))}
                  onChange={setAspect}
                />
              )}
            {adapter?.kind === 'video' && !declaresCount
              ? null
              : (
                <PillSelect
                  label="数量"
                  value={String(count)}
                  options={Array.from({ length: Math.max(1, (model as { maxN?: number } | undefined)?.maxN ?? 4) }, (_, index) => index + 1)
                    .map(value => ({ value: String(value), label: String(value) }))}
                  onChange={value => { setCount(Number(value)) }}
                />
              )}
            {declared.map(field => {
              const label = field.label ?? field.key
              const raw = params[field.key]
              if (field.kind === 'enum') {
                const options = field.options ?? []
                const current = String(raw ?? field.default ?? options[0]?.value ?? '')
                return (
                  <PillSelect
                    key={field.key}
                    label={label}
                    help={field.help}
                    value={current}
                    options={options.map(option => ({ value: String(option.value), label: option.label ?? String(option.value) }))}
                    onChange={value => { setParam(field.key, value) }}
                  />
                )
              }
              if (field.kind === 'boolean') {
                const current = raw === undefined ? String(field.default ?? false) : String(raw)
                return (
                  <PillSelect
                    key={field.key}
                    label={label}
                    help={field.help}
                    value={current === 'true' ? 'true' : 'false'}
                    options={[{ value: 'true', label: '开' }, { value: 'false', label: '关' }]}
                    onChange={value => { setParam(field.key, value === 'true') }}
                  />
                )
              }
              if (field.kind === 'number') {
                return (
                  <label key={field.key} className={css.pill} title={field.help ?? label}>
                    <span className={css.pillKey}>{label}</span>
                    <input
                      type="number"
                      value={raw === undefined ? String(field.default ?? '') : String(raw)}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      placeholder={field.placeholder ?? '默认'}
                      style={{ ['--pill-chars' as string]: String(Math.min(12, Math.max(5, String(raw ?? field.default ?? field.placeholder ?? '').length + 2))) }}
                      onChange={event => { setParam(field.key, event.target.value === '' ? undefined : Number(event.target.value)) }}
                      aria-label={label}
                    />
                  </label>
                )
              }
              return (
                <label key={field.key} className={css.pill} title={field.help ?? label}>
                  <span className={css.pillKey}>{label}</span>
                  <input
                    type="text"
                    value={raw === undefined ? String(field.default ?? '') : String(raw)}
                    placeholder={field.placeholder ?? '默认'}
                    style={{ ['--pill-chars' as string]: String(Math.min(18, Math.max(6, String(raw ?? field.default ?? field.placeholder ?? '').length + 2))) }}
                    onChange={event => { setParam(field.key, event.target.value === '' ? undefined : event.target.value) }}
                    aria-label={label}
                  />
                </label>
              )
            })}
            <button
              ref={sourceButton}
              type="button"
              className={css.chip}
              data-on={sourceMenu === undefined ? 'false' : 'true'}
              onClick={openSourceMenu}
            >
              ＋ 素材{attachments.length === 0 ? '' : ` ${String(attachments.length)}`}
            </button>
            <button type="button" className={css.chip} data-on={toolsOpen ? 'true' : 'false'} onClick={() => { setToolsOpen(open => !open) }}>
              ⋯ 工具
            </button>
            {hasClip && adapter?.kind === 'video' ? (
              <button type="button" className={css.chip} onClick={() => { setContinuumOpen(true) }}>续时长</button>
            ) : null}
            </div>
            <button type="button" className={css.send} disabled={!canSend} onClick={() => { void send() }}>
              {busy ? '生成中…' : '生成'}
            </button>
          </div>
          <div className={css.caps}>
            {capsLine}
            {model?.priceNote === undefined ? null : <span className={css.capsPrice}>{model.priceNote}</span>}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={event => { void attach(event.target.files); event.target.value = '' }}
          />
          <input
            ref={videoInput}
            type="file"
            accept="video/*"
            hidden
            onChange={event => { void attach(event.target.files); event.target.value = '' }}
          />
          {sourceMenu === undefined
            ? null
            : (
              <div ref={menuRef} className={css.sourceMenu} style={{ left: sourceMenu.left, top: sourceMenu.top }} role="menu">
                {SOURCE_MENU.map(item => (
                  <button
                    key={item.key}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setSourceMenu(undefined)
                      if (item.key === 'upload' || item.key === 'video') { pickLocal(item.key === 'video' ? 'video' : 'image'); return }
                      if (item.key === 'generate') { setSourceTab('generate'); return }
                      void loadSourceTab(item.key)
                    }}
                  >{item.label}</button>
                ))}
              </div>
            )}
          {sourceTab === undefined
            ? null
            : (
              <div
                className={css.sourceBackdrop}
                role="dialog"
                aria-modal="true"
                onClick={event => {
                  // 只有点在遮罩本身（不是弹窗内部）才关，和系统对话框一致。
                  if (event.target !== event.currentTarget) return
                  setSourceTab(undefined)
                  setSourceItems(undefined)
                  setSourceChosen([])
                }}
              >
                <section className={css.sourceDialog}>
                  <header className={css.sourceHeader}>
                    <strong>{
                      sourceTab === 'gallery' ? '素材库' : sourceTab === 'history' ? '历史记录' : 'AI 生成'
                    }</strong>
                    <button type="button" onClick={() => { setSourceTab(undefined); setSourceItems(undefined); setSourceChosen([]) }}>×</button>
                  </header>
                  {sourceTab === 'generate'
                    ? (
                      <div className={css.sourceGenerate}>
                        <textarea
                          rows={3}
                          value={sourcePrompt}
                          placeholder="写一句想生成的画面，生成结果直接作为参考素材"
                          onChange={event => { setSourcePrompt(event.target.value) }}
                        />
                        <div className={css.sourceGenerateRow}>
                          <span className={css.dim}>{adapter?.label ?? ''}{model === undefined ? '' : ` · ${model.alias}`}</span>
                          <select value={String(sourceCount)} onChange={event => { setSourceCount(Number(event.target.value)) }} aria-label="这次生成几张参考图">
                            {[1, 2, 3, 4].map(value => <option key={value} value={value}>{String(value)} 张</option>)}
                          </select>
                          <span className={css.spacer} />
                          <button type="button" disabled={sourceBusy || sourcePrompt.trim() === ''} onClick={() => { void generateSource() }}>
                            {sourceBusy ? '生成中…' : '生成并加入素材'}
                          </button>
                        </div>
                      </div>
                    )
                    : (
                      <>
                        <div className={css.sourceGrid}>
                          {sourceBusy && sourceItems === undefined ? <p className={css.dim}>读取中…</p> : null}
                          {sourceItems !== undefined && sourceItems.length === 0 ? <p className={css.dim}>这里是空的，去生成或上传几张吧</p> : null}
                          {(sourceItems ?? []).map(item => (
                            <button
                              key={item.key}
                              type="button"
                              className={css.sourceCard}
                              data-selected={sourceChosen.includes(item.key) ? 'true' : 'false'}
                              onClick={() => { setSourceChosen(current => current.includes(item.key) ? current.filter(key => key !== item.key) : [...current, item.key]) }}
                            >
                              <img src={item.url} alt="" />
                              <span>{item.label}</span>
                            </button>
                          ))}
                        </div>
                        <footer className={css.sourceFooter}>
                          <span className={css.dim}>已选 {String(sourceChosen.length)} 张</span>
                          <span className={css.spacer} />
                          <button type="button" disabled={sourceBusy || sourceChosen.length === 0} onClick={() => { void attachChosen() }}>
                            {sourceBusy ? '加入中…' : '加入素材'}
                          </button>
                        </footer>
                      </>
                    )}
                </section>
              </div>
            )}
          {editingField === undefined
            ? null
            : editingField.kind === 'enum'
              ? (
                <div className={css.pickRow}>
                  <span className={css.pickLabel}>{editingField.label ?? editingField.key}</span>
                  {(editingField.options ?? []).map(option => {
                    const current = params[editingField.key] ?? editingField.default ?? editingField.options?.[0]?.value
                    return (
                      <button
                        key={String(option.value)}
                        type="button"
                        className={css.pickBtn}
                        data-on={String(current ?? '') === String(option.value) ? 'true' : 'false'}
                        onClick={() => { setParam(editingField.key, option.value); setPick(undefined) }}
                      >{option.label ?? String(option.value)}</button>
                    )
                  })}
                  <span className={css.spacer} />
                  <button type="button" className={css.pickClose} onClick={() => { setPick(undefined) }}>×</button>
                </div>
              )
              : (
                <div className={css.pickRow} data-wrap="true">
                  <span className={css.pickLabel}>{editingField.label ?? editingField.key}</span>
                  {renderField(editingField)}
                  <span className={css.spacer} />
                  <button type="button" className={css.pickClose} onClick={() => { setPick(undefined) }}>×</button>
                </div>
              )}
          {toolsOpen
            ? (
              <div className={css.continuum}>
                <strong>工具</strong>
                <label>
                  请求预览
                  <button type="button" className={css.ghost} onClick={() => { void showPreview() }}>看这次会发出去的请求</button>
                  <small className={css.dim}>不发真请求、不计费，只按通道模板渲染出 URL / 请求头 / body，用来排查上游 400。</small>
                </label>
                <label>
                  拉取模型
                  <button type="button" className={css.ghost} disabled={adapter === undefined} onClick={() => { void discover() }}>从通道读模型清单</button>
                  <small className={css.dim}>调通道的 /v1/models，把新模型加进下拉，免手抄名字。</small>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={autoLibrary}
                    onChange={event => {
                      const next = event.target.checked
                      setAutoLibrary(next)
                      try { window.localStorage.setItem(AUTO_LIBRARY_KEY, next ? 'on' : 'off') } catch { /* storage unavailable */ }
                    }}
                  />
                  生成结果自动加入素材库
                  <small className={css.dim}>开：出图即入库，画布里直接从「素材库」取；关：用每张图下面的按钮手动入库。</small>
                </label>
              </div>
            )
            : null}
          {notice === undefined ? null : (
            <div className={css.notice} data-kind={notice.kind}>
              {notice.text}
              {notice.warnings === undefined ? null : <ul>{notice.warnings.map((warning, index) => <li key={String(index)}>{warning}</li>)}</ul>}
            </div>
          )}
          {preview === undefined ? null : (
            <div className={css.preview}>
              <div className={css.previewHead}>
                <strong>{preview.method} {preview.url}</strong>
                <button type="button" className={css.ghost} onClick={() => { setPreview(undefined) }}>关闭</button>
              </div>
              <pre>{JSON.stringify({ headers: preview.headers, body: preview.body }, null, 2)}</pre>
              {preview.omitted.length === 0 ? null : <p className={css.dim}>该模型不接受的字段：{preview.omitted.join('、')}</p>}
            </div>
          )}
          {continuumOpen
            ? (
              <div className={css.continuum}>
                <strong>续时长</strong>
                <p className={css.dim}>取上一段最后一帧作为下一段首帧，逐段渲染后拼接。</p>
                <label>
                  段数
                  <input type="number" min={1} max={12} value={String(continuumSegments)} onChange={event => { setContinuumSegments(Math.max(1, Math.min(12, Number(event.target.value) || 1))) }} />
                </label>
                <label>
                  接缝
                  <select value={String(continuumFade)} onChange={event => { setContinuumFade(Number(event.target.value)) }}>
                    <option value="0">硬切</option>
                    <option value="200">淡入淡出 0.2s</option>
                    <option value="400">淡入淡出 0.4s</option>
                  </select>
                </label>
                <span className={css.dim}>预计 {String(continuumSegments * (duration ?? 5))}s，{String(continuumSegments)} 次付费渲染</span>
                <div className={css.row}>
                  <button type="button" className={css.send} onClick={() => { void continueClip() }}>开始</button>
                  <button type="button" className={css.ghost} onClick={() => { setContinuumOpen(false) }}>取消</button>
                </div>
              </div>
            )
            : null}
          {discovered === undefined
            ? null
            : (
              <div className={css.discover}>
                <div className={css.previewHead}>
                  <strong>发现 {String(discovered.length)} 个模型</strong>
                  <button type="button" className={css.ghost} onClick={() => { setDiscovered(undefined) }}>关闭</button>
                </div>
                <div className={css.discoverList}>
                  {discovered.map(entry => (
                    <button
                      key={entry.id}
                      type="button"
                      className={css.discoverItem}
                      data-known={entry.known ? 'true' : 'false'}
                      onClick={() => { if (!entry.known) void adoptModel(entry) }}
                      title={entry.description ?? entry.id}
                    >
                      <span>{entry.id}</span>
                      <span className={css.dim}>{entry.kind === 'video' ? '视频' : '图片'}{entry.priceNote === undefined ? '' : ` · ${entry.priceNote}`}{entry.known ? ' · 已添加' : ' · 点击添加'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
