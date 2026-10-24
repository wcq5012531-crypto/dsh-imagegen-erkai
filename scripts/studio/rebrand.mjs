/**
 * One-shot rebrand: turn the upstream fork identity into `dsh-imagegen-studio`
 * without touching anything the DSH host keys off (settings namespace, HTTP
 * routes, DOM attributes all stay `dsh-imagegen-studio` so existing user config,
 * history and galleries keep working).
 *
 * Idempotent: running it twice is a no-op.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const OLD_PKG = '@q253595422/dsh-imagegen-video'
const NEW_PKG = 'dsh-imagegen-studio'
const OLD_ENTRY = 'imagegen'
const NEW_ENTRY = 'imagegen-studio'

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const write = (rel, text) => writeFileSync(join(ROOT, rel), text)
const sub = (rel, pairs) => {
  let text = read(rel)
  const before = text
  for (const [from, to] of pairs) text = text.split(from).join(to)
  if (text !== before) { write(rel, text); console.log(`patched ${rel}`) }
}

// ---------------------------------------------------------------- package.json
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.name = NEW_PKG
pkg.version = '1.16.0'
pkg.description = 'dsh-imagegen-studio — AI image + video studio plugin for the dsh web GUI. '
  + 'A fork of @q253595422/dsh-imagegen-video that keeps the whole image pipeline, the video pipeline '
  + 'and the infinite canvas, and adds (1) a user-defined protocol adapter layer so any gateway model '
  + 'can be wired up by pasting a cURL command, with per-model size / aspect / duration / extra-field '
  + 'mapping, request templating, response path extraction and dry-run preview; (2) one-click replicate '
  + '(reference image or clip to prompt + parameters + render); (3) one-click duration continuation '
  + '(tail-frame chaining to extend a clip past the provider cap, with optional crossfade).'
pkg.author = 'yg'
pkg.repository = { type: 'git', url: 'git+https://github.com/local/dsh-imagegen-studio.git' }
pkg.homepage = 'https://github.com/local/dsh-imagegen-studio#readme'
pkg.bugs = { url: 'https://github.com/local/dsh-imagegen-studio/issues' }
pkg.keywords = [...new Set([
  ...(pkg.keywords ?? []),
  'protocol-adapter',
  'curl-import',
  'video-continuation',
  'one-click-replicate',
  'comfyui-continuum',
])]
// The fork has no update channel to poll: leaving the upstream self-updater in
// place would silently overwrite local changes on the next release.
pkg.scripts = { ...(pkg.scripts ?? {}), 'studio:rebrand': 'node scripts/studio/rebrand.mjs' }
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
console.log('patched package.json')

// ------------------------------------------------------------- cordis.patch.yml
sub('cordis.patch.yml', [
  [`- id: ${OLD_ENTRY}`, `- id: ${NEW_ENTRY}`],
  [`name: '${OLD_PKG}'`, `name: '${NEW_PKG}'`],
  ['# dsh-imagegen-studio bundle patch', '# dsh-imagegen-studio bundle patch'],
])

// ---------------------------------------------------------------- tsdown.config.ts
sub('tsdown.config.ts', [
  [`const ID = '${OLD_PKG}'`, `const ID = '${NEW_PKG}'`],
  [`Standalone tsdown build for ${OLD_PKG}.`, `Standalone tsdown build for ${NEW_PKG}.`],
])

// ---------------------------------------------------------------- host entry id
sub('src/index.ts', [
  [`export const name = '${OLD_ENTRY}'`, `export const name = '${NEW_ENTRY}'`],
])

console.log('rebrand complete')
