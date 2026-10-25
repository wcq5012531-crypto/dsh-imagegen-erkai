/**
 * `lib/` 进仓库之后，新的坑是"改了 `src/` 忘了 build"：源码是最新的，推上去的
 * 构建产物还是旧的，而从 GitHub 装插件的人拿到的是 `lib/`（安装时不会替他 build，
 * pnpm 默认禁止 git 包跑构建脚本）。这种漂移在作者机器上完全看不出来——本地还在
 * 跑 `lib/` 的旧产物也一样能用。
 *
 * 所以这个检查放在 `npm test` 的 build 之后：build 完还看到 `lib/` 有未提交的改动，
 * 就是产物与提交不同步，先提交再跑。
 *
 * 不是 git 仓库（解开的 tarball）就 SKIP，并把"没检查"说出来——一个安静通过的
 * 检查比没有检查更坏。
 */
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function git (...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
}

try {
  git('rev-parse', '--is-inside-work-tree')
} catch {
  console.log('SKIP  not a git checkout: lib/ freshness was NOT verified.')
  process.exit(0)
}

const status = git('status', '--porcelain', '--', 'lib').trim()
if (status === '') {
  console.log('PASS  lib/ matches the committed build output.')
  process.exit(0)
}

console.error('FAIL  lib/ differs from the committed build output:')
for (const line of status.split('\n')) console.error(`  ${line}`)
console.error('\nRun `npm run build` and commit lib/ — a git install ships lib/, not src/.')
process.exit(1)
