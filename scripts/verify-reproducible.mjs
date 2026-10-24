/**
 * Assert that the build is a pure function of the source tree.
 *
 * WHY this is a check and not a note in the release notes: the release workflow
 * publishes `SHA256SUMS` next to a tarball it just packed, and re-running that
 * workflow replaces a release's assets. Both of those only mean something if
 * the same commit produces the same bytes. They did not. `lightningcss` returns
 * CSS-module exports from a native hash map, `tsdown.config.ts` serialised the
 * map in iteration order, and that order differed on every process: five runs
 * over one stylesheet produced five different first keys. Every build therefore
 * produced a different `lib/client.js`, so a published checksum could never be
 * reproduced from source and "the Release ships the tested bytes" was true only
 * for the run that happened to make it.
 *
 * Nothing broke visibly -- object key order is invisible to every consumer of a
 * CSS-module map -- which is exactly why it needs an assertion. A silent
 * property is not maintained by remembering it.
 *
 * Two full builds, because a difference in ANY of the twelve stylesheets shows
 * up in the same output file, and because a partial reproduction (rebuild only
 * what changed) would not exercise the same path the release does. A build
 * takes well under a second here.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** The artifacts whose bytes end up inside the published archive. */
const ARTIFACTS = ['lib/client.js', 'lib/index.js', 'lib/locale-tables.js', 'lib/locale-tables-chunk.js']

/**
 * Run the repository's build script, whatever the package manager is called on
 * this machine. `pnpm` stays first because that is what CI uses; the fallbacks
 * exist because the deterministic-bytes property is worth checking on a host
 * that only has the runtime (this one runs node as the desktop app's embedded
 * runtime, with no pnpm shim on PATH) and every runner executes the same script.
 */
function build () {
  // npm is an `.cmd` shim on Windows: the bare name is a hard ENOENT without a
  // shell, and Node refuses to spawn a `.cmd` even WITH the full name (EINVAL)
  // since the 2024 command-injection hardening. So the Windows run goes through
  // the shell. Both arguments are literals above, not this process's input.
  const win = process.platform === 'win32'
  const runners = [
    ['pnpm', ['build']],
    ['npm', ['run', 'build']],
  ]
  let last
  for (const [command, args] of runners) {
    try {
      execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: 'ignore', shell: win })
      return
    } catch (error) {
      if (error.code === 'ENOENT') { last = error; continue }
      throw error
    }
  }
  throw new Error(`no build runner found (tried pnpm, npm): ${last?.message ?? ''}`)
}

function digests () {
  const out = new Map()
  for (const artifact of ARTIFACTS) {
    out.set(artifact, createHash('sha256').update(readFileSync(join(ROOT, artifact))).digest('hex'))
  }
  return out
}

function fail (lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

build()
const first = digests()
build()
const second = digests()

const drifted = ARTIFACTS.filter(artifact => first.get(artifact) !== second.get(artifact))

if (drifted.length > 0) {
  fail([
    '',
    'FAIL: two builds of the same source tree produced different bytes:',
    ...drifted.map(artifact => `  - ${artifact}\n      first  ${first.get(artifact)}\n      second ${second.get(artifact)}`),
    '',
    'The release publishes SHA256SUMS for exactly the tarball it packed, and',
    're-running that workflow replaces a release\'s assets. Neither can be',
    'trusted -- and no checksum can be reproduced from source -- while the',
    'same input yields different output.',
    '',
    'The usual cause is serialising a value whose iteration order is not',
    'defined: a native hash map (see the CSS-module exports in tsdown.config.ts),',
    'a Set/Map built from async work, or a directory listing. Sort it at the',
    'point where it becomes bytes, not where it is produced.',
  ])
}

console.log(`reproducible: ${ARTIFACTS.length} artifacts are byte-identical across two builds`)
