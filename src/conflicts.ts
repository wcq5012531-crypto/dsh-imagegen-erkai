/**
 * 与同名路由/工具/settings 命名空间撞车的插件检测。
 *
 * WHY：本插件注册的是 `/api/dsh-imagegen-studio/*` 这一整组路由、`generate_image`
 * 这批工具、以及 `plugin:dsh-imagegen-studio` 这个提示词段。上游的同源插件
 * （`@q253595422/dsh-imagegen-video`）注册的是同一套东西——两个都启用时，先到的
 * 那个占住名字，后到的在 `apply()` 里抛 "already registered"，表现是路由重复、
 * 工具重复，严重时整个 Web 端卡在 "正在读取本地工作台"。这类冲突不该等到用户
 * 撞上才解释，也不该让宿主静默吞掉：启动时认出来，直接报清楚该怎么办。
 *
 * 判定刻意保守：只有"装了" **且** "真的会被加载"才算冲突。插件市场里禁用一
 * 个 bundle 的做法是把它从 `dsh.profile.bundles` 里摘掉，所以不在 bundles 里的
 * 一律视为已禁用；profile 的补丁层里把它整行标成 `disabled: true` 同样算禁用。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { profileFromProcess } from './updater.ts'

/** 和本插件注册同一套路由 / 工具 / 设置命名空间的包。 */
export const CONFLICTING_PACKAGES = ['@q253595422/dsh-imagegen-video', '@dickpy/dsh-imagegen-studio'] as const

/** 一处已启用（会被加载）的冲突。 */
export interface PluginConflict {
  /** 冲突包名。 */
  name: string
  /** 它出现在哪个 profile 的 bundles 里。 */
  profile: string
}

/** `$DSH_HOME`，缺省落到 `~/.dsh`（与宿主其它部分一致）。 */
function dshHome(): string {
  const configured = (process.env.DSH_HOME ?? '').trim()
  return configured === '' ? join(homedir(), '.dsh') : configured
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: unknown } }
}

function readManifest(path: string): ProfileManifest | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProfileManifest
  } catch {
    return undefined
  }
}

function bundlesOf(manifest: ProfileManifest | undefined): string[] {
  const list = manifest?.dsh?.profile?.bundles
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * profile 的补丁层是否把某个包整行关掉了。
 *
 * 只看 `disabled: true` 里"这一行属于谁"——行里 `name:` 指向的包名在 `name:`
 * 之后、下一个 `- id:` 之前出现，就认为这一行是它的。够用且不依赖 YAML 解析器
 * （宿主可能没装，插件也不该为这点事多背一个依赖）。
 */
function disabledInPatchLayer(patchPath: string, name: string): boolean {
  if (!existsSync(patchPath)) return false
  let text: string
  try {
    text = readFileSync(patchPath, 'utf8')
  } catch {
    return false
  }
  for (const block of text.split(/\n(?=\s*-\s+id:)/)) {
    if (!block.includes(`name: "${name}"`) && !block.includes(`name: '${name}'`) && !block.includes(`name: ${name}`)) continue
    if (/^\s*disabled:\s*true\s*$/m.test(block)) return true
  }
  return false
}

/**
 * 找出"装了、并且会被加载"的冲突插件。
 *
 * @param profile - profile 名；缺省从启动参数推断（宿主会把 `--profile` 传下来）。
 * @param home - `$DSH_HOME`，测试用。
 */
export function findPluginConflicts(profile = profileFromProcess(), home = dshHome()): PluginConflict[] {
  const dir = join(home, 'profiles', profile)
  const manifest = readManifest(join(dir, 'package.json'))
  if (manifest === undefined) return []
  const installed = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ])
  const bundles = bundlesOf(manifest)
  const patchPath = join(dir, 'cordis.patch.yml')
  const hits: PluginConflict[] = []
  for (const name of CONFLICTING_PACKAGES) {
    if (!installed.has(name) && !bundles.includes(name)) continue
    // 装了但没列进 bundles：市场"禁用"就是这个形态，不加载，不算冲突。
    if (!bundles.includes(name)) continue
    if (disabledInPatchLayer(patchPath, name)) continue
    hits.push({ name, profile })
  }
  return hits
}

/** 给用户看的处理建议（抛错和日志共用一份措辞）。 */
export function conflictMessage(hits: readonly PluginConflict[]): string {
  const names = [...new Set(hits.map(hit => hit.name))].join('、')
  return `检测到已启用的冲突插件 ${names}：它和 dsh-imagegen-studio 注册同一套 `
    + '/api/dsh-imagegen-studio/* 路由、同一批工具和同一个设置命名空间，同时加载会重复注册'
    + '（严重时整个页面会卡在“正在读取本地工作台”）。'
    + `请先在「设置 → 插件」或插件市场里禁用或卸载 ${names}，再重启 DSH。`
}
