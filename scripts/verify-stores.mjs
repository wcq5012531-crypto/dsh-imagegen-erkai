/**
 * Store-level checks for the two host stores that own user data.
 *
 * The GUI smoke tests (`scripts/smoke.mjs` and friends) mount the plugin, so
 * they need the whole host toolchain installed. These two stores are
 * framework-free by design, which means they can be driven directly: this
 * script points `DSH_HOME` at a throwaway directory, calls the real exported
 * functions, and asserts what lands on disk. Nothing here mocks the stores.
 *
 * Run: node scripts/verify-stores.mjs
 *
 * Needs Node's built-in type stripping (22.18+, 23.6+ by default). On an older
 * runtime the script prints a skip block and exits 0 — a missing runtime is not
 * a failing store, and a silent pass would be worse than either.
 */

import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const nodeMajor = Number(process.versions.node.split('.')[0])
if (!(nodeMajor >= 22)) {
  console.error('\n' + '='.repeat(72))
  console.error('SKIP: store checks need Node >= 22.18 for native type stripping.')
  console.error(`This run used ${process.versions.node}.`)
  console.error('='.repeat(72) + '\n')
  process.exit(0)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const root = fs.mkdtempSync(path.join(tmpdir(), 'dsh-stores-'))
process.env.DSH_HOME = root

const H = await import(pathToFileURL(path.join(here, '..', 'src', 'history-store.ts')).href)
const G = await import(pathToFileURL(path.join(here, '..', 'src', 'gallery-store.ts')).href)

let failures = 0
function check (label, ok, detail) {
  if (ok) { console.log(`ok   ${label}`); return }
  failures++
  console.log(`FAIL ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
}
async function rejects (label, run) {
  try { await run() } catch { console.log(`ok   ${label}`); return }
  failures++
  console.log(`FAIL ${label} -> did not throw`)
}

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')
const entry = (id, prompt) => ({
  id,
  createdAt: Date.now(),
  mode: 'text',
  model: 'model-x',
  prompt,
  size: '1:1',
  quality: 'auto',
  detail: 'auto',
  n: 1,
  images: [{ mime: 'image/png', b64: png }],
})

try {
  // --- history archive -----------------------------------------------------
  await H.appendHistory(entry('a1', 'first'))
  await H.appendHistory(entry('a2', 'second'))
  check('history lists both', (await H.listHistory()).length === 2)

  const moved = await H.setHistoryArchived('a1', true)
  check('archive moves one out of the live list', moved.entries.length === 1, moved.entries.length)
  check('archive fills the archived half', moved.archived.length === 1, moved.archived.length)
  check('live list excludes archived', (await H.listHistory()).length === 1)
  check('archived list has the entry', (await H.listArchivedHistory())[0]?.id === 'a1')

  const back = await H.setHistoryArchived('a1', false)
  check('unarchive returns it', back.entries.length === 2 && back.archived.length === 0)

  await H.setHistoryArchived('missing-id', true)
  check('archiving an unknown id is a no-op', (await H.listHistory()).length === 2)

  // An unarchived entry must not carry the flag at all: older builds parse the
  // index strictly, and a written `archived: false` would make every round trip
  // dirty the file.
  const dataDir = path.join(root, 'dsh-imagegen-studio')
  const rawIndex = fs.readFileSync(path.join(dataDir, 'index.json'), 'utf8')
  check('unarchived index carries no archived flag', !rawIndex.includes('"archived"'), rawIndex.slice(0, 120))

  await H.setHistoryArchived('a1', true)
  const afterRemove = await H.removeHistory('a1')
  check('an archived entry can still be deleted', afterRemove.every(item => item.id !== 'a1'))
  check('its images are gone too', !fs.existsSync(path.join(dataDir, 'images', 'a1-0.png')))

  // --- gallery categories --------------------------------------------------
  let snapshot = await G.createGalleryCategory('灵感')
  check('create adds the category', snapshot.categories.includes('灵感'), JSON.stringify(snapshot.categories))
  await G.createGalleryCategory('  灵感  ')
  check('create is idempotent after trimming', (await G.listGalleryCategories()).categories.filter(name => name === '灵感').length === 1)
  await rejects('blank name is rejected', () => G.createGalleryCategory('   '))

  snapshot = await G.createGalleryCategory('工作')
  snapshot = await G.renameGalleryCategory('工作', '办公')
  check('rename replaces the old name', snapshot.categories.includes('办公') && !snapshot.categories.includes('工作'), JSON.stringify(snapshot.categories))

  // Renaming has to follow the entries, not just the registry. Tags are set by
  // the tag route — `appendGallery` writes metadata only — so use it here too.
  await G.appendGallery(entry('g1', 'with a tag'))
  await G.updateGalleryTags('g1', ['办公'])
  snapshot = await G.renameGalleryCategory('办公', '工作')
  const tagged = snapshot.entries.find(item => item.id === 'g1')
  check('rename rewrites entry tags', tagged !== undefined && (tagged.tags ?? []).includes('工作'), JSON.stringify(tagged?.tags ?? []))

  snapshot = await G.renameGalleryCategory('工作', '灵感')
  check('renaming onto an existing shelf merges it', snapshot.categories.filter(name => name === '灵感').length === 1, JSON.stringify(snapshot.categories))

  snapshot = await G.deleteGalleryCategory('灵感')
  check('delete drops the category', !snapshot.categories.includes('灵感'), JSON.stringify(snapshot.categories))
  const untagged = snapshot.entries.find(item => item.id === 'g1')
  check('delete strips the tag but keeps the image', untagged !== undefined && (untagged.tags ?? []).length === 0)
  const fileName = String(untagged?.images?.[0]?.url ?? '').split('/').pop()
  check('the image file survives a category delete', fileName !== '' && fs.readdirSync(root, { recursive: true }).some(entry => String(entry).replace(/\\/g, '/').endsWith(`/${fileName}`)), fileName)

  const restored = await G.listGalleryCategories()
  check('listGalleryCategories returns both halves', Array.isArray(restored.entries) && Array.isArray(restored.trash))
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nSTORE CHECKS PASSED' : `\n${failures} STORE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
