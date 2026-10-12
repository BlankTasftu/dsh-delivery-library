/**
 * 只读的 asar 抽取器（本插件项目自用工具）。
 *
 * 用途：把 DSH 主机 app.asar 里的内置包源码抽到工作区，用来读**权威契约**
 * （槽位声明、标准 props、宿主服务方法签名），而不是靠猜。
 *
 * 用法：
 *   node tools/asar-extract.mjs list <asar> [pathPrefix]          # 只列不写
 *   node tools/asar-extract.mjs extract <asar> <outDir> <prefix…> # 抽取到工作区
 *
 * asar 布局（Electron）：
 *   0..3   uint32  第一个 pickle 的载荷长度（恒为 4）
 *   4..7   uint32  header pickle 的长度（= headerSize）
 *   8..11  uint32  header pickle 的载荷长度（= json 长度 + 4）
 *   12..15 uint32  header JSON 的字节长度
 *   16..   header JSON
 *   files 从 8 + headerSize 起，按 node.offset 偏移取字节
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const [mode, asarPath, ...rest] = process.argv.slice(2)
if (mode !== 'list' && mode !== 'extract') {
  console.error('用法: node tools/asar-extract.mjs <list|extract> <asar> [outDir] <prefix…>')
  process.exit(2)
}

const archive = readFileSync(asarPath)
const headerPickleSize = archive.readUInt32LE(4)
const jsonSize = archive.readUInt32LE(12)
const header = JSON.parse(archive.subarray(16, 16 + jsonSize).toString('utf8'))
const dataStart = 8 + headerPickleSize

/** 深度优先遍历 header 树，回调 (path, node)。 */
function walk(node, prefix, visit) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : prefix + '/' + name
    if (child.files !== undefined) walk(child, path, visit)
    else visit(path, child)
  }
}

const files = []
walk(header, '', (path, node) => files.push({ path, node }))

if (mode === 'list') {
  const prefix = rest[0] ?? ''
  const matched = files.filter((entry) => entry.path.startsWith(prefix))
  for (const entry of matched.slice(0, 500)) {
    console.log(String(entry.node.size).padStart(10), entry.path)
  }
  console.log(`# ${matched.length} file(s) matched (shown ${Math.min(matched.length, 500)})`)
} else {
  const [outDir, ...prefixes] = rest
  if (outDir === undefined || prefixes.length === 0) {
    console.error('extract 需要 <outDir> 与至少一个 <prefix>')
    process.exit(2)
  }
  const root = resolve(outDir)
  let written = 0
  let skippedUnpacked = 0
  for (const { path, node } of files) {
    if (!prefixes.some((prefix) => path.startsWith(prefix))) continue
    if (node.unpacked === true) {
      skippedUnpacked += 1
      continue
    }
    if (typeof node.offset !== 'string') continue
    const bytes = archive.subarray(
      dataStart + Number(node.offset),
      dataStart + Number(node.offset) + node.size,
    )
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
    written += 1
  }
  console.log(`# wrote ${written} file(s) into ${root} (skipped ${skippedUnpacked} unpacked)`)
}
