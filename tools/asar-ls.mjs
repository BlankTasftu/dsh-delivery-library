/**
 * 列出 app.asar 内某个目录下的直接子项（名称 + 是否目录）。
 *
 * 用法: node tools/asar-ls.mjs <asar> <dirPath>
 */
import { readFileSync } from 'node:fs'

const [asarPath, dirPath] = process.argv.slice(2)
const archive = readFileSync(asarPath)
const headerPickleSize = archive.readUInt32LE(4)
const jsonSize = archive.readUInt32LE(12)
const header = JSON.parse(archive.subarray(16, 16 + jsonSize).toString('utf8'))

let node = header
for (const segment of dirPath.split('/').filter((part) => part !== '')) {
  node = node.files?.[segment]
  if (node === undefined) {
    console.error(`not found: ${segment}`)
    process.exit(1)
  }
}
for (const [name, child] of Object.entries(node.files ?? {})) {
  const kind = child.files !== undefined ? 'dir ' : 'file'
  const size = child.files !== undefined ? '' : String(child.size)
  console.log(`${kind}\t${size}\t${name}`)
}
void headerPickleSize
