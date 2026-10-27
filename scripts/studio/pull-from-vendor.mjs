import fs from 'node:fs'
import path from 'node:path'

// 把 vendor 里（可能是 Cursor 里直接改的）源码同步回仓库，让仓库成为唯一可编译源。
const vendor = 'C:/Users/Administrator/AppData/Roaming/dsh-desktop/harness/profiles/web/vendor/dsh-imagegen-studio/src'
const repo = 'C:/Users/Administrator/Documents/dsh-imagegen-studio/src'

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

const copied = []
const created = []
for (const rel of walk(vendor)) {
  const from = path.join(vendor, rel)
  const to = path.join(repo, rel)
  const exists = fs.existsSync(to)
  if (exists && fs.readFileSync(from).equals(fs.readFileSync(to))) continue
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  copied.push(rel)
  if (!exists) created.push(rel)
}

console.log('synced back:', copied.length === 0 ? '(nothing changed)' : '')
for (const rel of copied) console.log('  ' + (created.includes(rel) ? 'new      ' : 'updated  ') + rel)
