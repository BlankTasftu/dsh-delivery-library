/**
 * 只读探针：从 DSH 的 `/plugins/events`（SSE，本机免鉴权）读**首帧完整启动图**，
 * 回答两个问题：
 *   1. 本插件的客户端行在不在图里（宿主是否扫到了 `dsh.client` 声明）；
 *   2. 它在哪个批次里（浏览器启动时会不会加载它）。
 *
 * 不写任何东西。用法:
 *   node tools/check-boot-graph.mjs [url]
 * 默认地址走环境变量 DSH_WEB_URL（见 tools/paths.mjs），回退 http://127.0.0.1:19387。
 */
import { webEventsUrl } from './paths.mjs'

const url = process.argv[2] ?? webEventsUrl()
const packageName = 'dsh-delivery-library'

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 8000)
let frame = ''
try {
  const response = await fetch(url, { signal: controller.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  while (frame.indexOf('\n\n') < 0) {
    const { value, done } = await reader.read()
    if (done) break
    frame += decoder.decode(value, { stream: true })
  }
  await reader.cancel()
} finally {
  clearTimeout(timer)
}

const line = frame
  .split('\n')
  .find((candidate) => candidate.startsWith('data:'))
if (line === undefined) {
  console.error('没有收到 graph 帧。原始内容：', frame.slice(0, 400))
  process.exit(1)
}
const payload = JSON.parse(line.slice(5).trim())
if (payload.type !== 'graph') {
  console.error('首帧不是 graph：', payload.type)
  process.exit(1)
}
const graph = payload.graph
const row = graph.entries.find((entry) => entry.id === packageName)
const batch = graph.batches.find((candidate) => (candidate.entries ?? []).includes(packageName))

console.log('graph rev        :', graph.rev)
console.log('entries / batches:', graph.entries.length, '/', graph.batches.length)
console.log('社区插件在图中的情况：')
for (const name of ['dsh-ark', 'dsh-media-preview', 'dsh-whale-widget', packageName]) {
  const found = graph.entries.find((entry) => entry.id === name)
  const inBatch = graph.batches.find((candidate) => (candidate.entries ?? []).includes(name))
  console.log(
    `  ${found === undefined ? '❌' : '✅'} ${name.padEnd(22)} ${found === undefined ? '不在图中' : `rev=${found.rev} 批次=${inBatch?.phase ?? '无'}`}`,
  )
}
console.log('本插件在图中     :', row === undefined ? '❌ 没有' : '✅ 有')
if (row !== undefined) {
  console.log('  url            :', row.url)
  console.log('  rev            :', row.rev)
  console.log('  inject         :', JSON.stringify(row.inject ?? []))
}
console.log('所属批次         :', batch === undefined ? '❌ 不在任何批次（启动时不会被加载）' : `${batch.phase} → ${batch.entries.length} 个条目`)

// ── 再往前一步：按批次 URL 真取一次，验证"拼接后的脚本"确实含本插件的 bundle ──
if (batch !== undefined) {
  const base = new URL(url)
  const batchUrl = new URL(batch.url, `${base.protocol}//${base.host}/`).href
  const response = await fetch(batchUrl, { signal: AbortSignal.timeout(15000) })
  const body = await response.text()
  const hasMe = body.includes(`id: '${packageName}'`) || body.includes(`id: "${packageName}"`)
  console.log('批次 URL         :', batchUrl)
  console.log('批次响应         :', response.status, `${body.length} 字符`)
  console.log('含本插件代码     :', hasMe ? '✅ 是' : '❌ 否')
  try {
    new Function(body)
    console.log('批次脚本可解析   : ✅ 是')
  } catch (error) {
    console.log('批次脚本可解析   : ❌ 否 —', error.message)
  }
  if (!response.ok || !hasMe) process.exit(1)
}
process.exit(row !== undefined && batch !== undefined ? 0 : 1)
