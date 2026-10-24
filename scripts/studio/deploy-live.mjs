#!/usr/bin/env node
/**
 * 把构建产物同步到 DSH 桌面端「实际加载」的那份插件目录。
 *
 * 为什么需要这个脚本：生成目录长这样
 *   profiles/.generations/live/<name>+<ver>+<hash>/
 *     ├── lib/          ← 这里拷进去没用，运行时不会读
 *     └── node_modules/dsh-imagegen-studio/   ← 真正被 link 加载的就是这一份
 * 早期手工部署时把 lib 拷到了生成目录根下，界面因此「一点都没变」。这个脚本
 * 从 profiles/<name>/package.json 的 pnpm.overrides 里读出 link 目标，直接写进去。
 *
 * 用法：node scripts/studio/deploy-live.mjs [--dry]
 */

import { existsSync, readdirSync, readFileSync, cpSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const name = pkg.name
const dry = process.argv.includes('--dry')

const profilesRoot = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
  'dsh-desktop',
  'harness',
  'profiles',
)

if (!existsSync(profilesRoot)) {
  console.error(`找不到 profiles 目录：${profilesRoot}`)
  process.exit(1)
}

/** 在所有 profile 里找到指向本插件的 link 目标。 */
const targets = []
for (const profile of readdirSync(profilesRoot, { withFileTypes: true })) {
  if (!profile.isDirectory()) continue
  const manifestPath = join(profilesRoot, profile.name, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  // Two install shapes reach the same directory: an override that pins the
  // package to a checked-out copy, or a plain `link:` dependency. Look at both,
  // otherwise a profile that links the plugin directly looks "not installed".
  const overrides = manifest.pnpm?.overrides ?? {}
  const spec = overrides[name] ?? manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
  if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
  const linked = resolve(join(profilesRoot, profile.name), spec.slice('link:'.length))
  if (existsSync(linked)) targets.push({ profile: profile.name, linked })
}

if (targets.length === 0) {
  console.error(`没有任何 profile 通过 link: 加载 ${name}。先在「设置 → 插件」里安装/更新一次。`)
  process.exit(1)
}

const copy = (from, to) => {
  if (!existsSync(from)) return
  if (dry) {
    console.log(`[dry] ${from} -> ${to}`)
    return
  }
  rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
}

let wrote = 0
for (const target of targets) {
  console.log(`\nprofile ${target.profile}\n  -> ${target.linked}`)
  copy(join(repo, 'lib'), join(target.linked, 'lib'))
  copy(join(repo, 'src'), join(target.linked, 'src'))
  for (const file of ['package.json', 'cordis.patch.yml', 'CHANGELOG.md', 'README.md']) {
    const from = join(repo, file)
    if (existsSync(from) && !dry) cpSync(from, join(target.linked, file))
  }
  const bundle = join(target.linked, 'lib', 'client.js')
  if (existsSync(bundle)) {
    const { size, mtime } = statSync(bundle)
    console.log(`  client.js ${size} bytes @ ${mtime.toISOString()}`)
    wrote += 1
  }
}

console.log(`\n完成：${String(wrote)} 个加载点已同步${dry ? '（dry run）' : ''}。重启 DSH 窗口后生效。`)
