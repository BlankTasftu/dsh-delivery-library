/**
 * Profile patch 体检（只读）。
 *
 * 为什么需要它：`cordis.patch.yml` 会被"启用/停用插件""设置页保存"这类操作**整份重写**，
 * 只保留管理器自己管的条目 —— 手写条目（尤其 `agent-default-model` 的 provider/model）
 * 会**静默消失**。后果不是报错，而是新会话直接跑不起来：
 *   llm-deepseek: no API key for provider route "deepseek-official"
 * 因为它丢了以后默认模型会落回 API Key 路由，而本机是用账号登录的。
 *
 * 这个工具做两件事：
 *   1. 用 DSH 自带的 js-yaml（从 app.asar 里取，不引入依赖）**真解析**该文件，
 *      确保 YAML 没写坏（写坏了整个 profile 起不来）；
 *   2. 逐条检查关键条目是否还在，缺了就明确告诉你缺什么、要粘回什么。
 *
 * 用法：
 *   node tools/check-profile-patch.mjs [profileDir] [--asar <path>]
 * 退出码：0 = 正常；1 = 有问题（YAML 坏了或缺关键条目）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { asarPath as resolveAsarPath, profileDir as defaultProfileDir } from './paths.mjs'

// 缓存放系统临时目录：这样即使这个包被安装在 node_modules 里（只读或不该被写），
// 工具也不会往包目录或工作区里落文件。
const cacheDir = join(tmpdir(), 'dsh-delivery-library-tools')

const args = process.argv.slice(2)
const asarFlag = args.indexOf('--asar')
const asarPath = resolveAsarPath(asarFlag >= 0 ? args[asarFlag + 1] : undefined)
const positional = args.find((value, index) => value.startsWith('--') === false && index !== asarFlag + 1)
const profileDir = resolve(positional ?? defaultProfileDir())

/** 从 app.asar 抽出 js-yaml 的 ESM 单文件（缓存到系统临时目录，不落进工作区/包目录）。 */
function loadYaml() {
  const cachePath = join(cacheDir, 'js-yaml.mjs')
  if (!existsSync(cachePath)) {
    if (!existsSync(asarPath)) throw new Error(`找不到 app.asar：${asarPath}`)
    const archive = readFileSync(asarPath)
    const headerPickleSize = archive.readUInt32LE(4)
    const jsonSize = archive.readUInt32LE(12)
    const header = JSON.parse(archive.subarray(16, 16 + jsonSize).toString('utf8'))
    const wanted = 'dsh/node_modules/js-yaml/dist/js-yaml.mjs'
    let node = header
    for (const segment of wanted.split('/')) {
      node = node.files?.[segment]
      if (node === undefined) throw new Error(`app.asar 里没有 ${wanted}`)
    }
    const start = 8 + headerPickleSize + Number(node.offset)
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cachePath, archive.subarray(start, start + node.size))
  }
  return import(pathToFileURL(cachePath).href)
}

const patchPath = join(profileDir, 'cordis.patch.yml')
const pkgPath = join(profileDir, 'package.json')

const yaml = await loadYaml()
const problems = []

console.log('profile      :', profileDir)
console.log('patch 文件   :', patchPath)

// ① YAML 能不能解析
let entries
try {
  const text = readFileSync(patchPath, 'utf8')
  entries = yaml.load(text)
  if (!Array.isArray(entries)) throw new Error('顶层不是数组')
  console.log('YAML 解析    : ✅ 通过，顶层数组 ' + entries.length + ' 条')
} catch (error) {
  console.error('YAML 解析    : ❌ 失败 ——', error.message)
  console.error('  ⚠️ 这份文件写坏会让整个 profile 起不来，请立刻修好。')
  process.exit(1)
}

const byId = new Map()
for (const entry of entries) {
  if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') byId.set(entry.id, entry)
}

// ② agent-default-model：provider + model 必填，缺了新会话就跑不起来
const defaults = byId.get('agent-default-model')
if (defaults === undefined) {
  problems.push(
    '缺 `agent-default-model` 条目 → 新会话会报 no API key for provider route "deepseek-official"',
  )
} else {
  const config = defaults.config ?? {}
  if (typeof config.provider !== 'string' || typeof config.model !== 'string') {
    problems.push('`agent-default-model` 缺 provider 或 model（schema 要求两者必填）')
  } else {
    console.log(`默认模型     : ✅ ${config.provider} / ${config.model}`)
  }
}

// ③ 其余手写条目（丢了只是降级，列出来便于你判断）
for (const id of ['dsh-ark', 'ui-conversation', 'ui-chat', 'ui-settings', 'ui-settings-account']) {
  console.log(`条目 ${id.padEnd(22)}: ${byId.has(id) ? '在' : '不在'}`)
}

// ④ bundles 清单里核心 bundle 是否还在
try {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const bundles = pkg?.dsh?.profile?.bundles ?? []
  console.log('bundles      :', bundles.length, '条')
  for (const required of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    if (!bundles.includes(required)) problems.push(`profile 的 bundles 少了 ${required}`)
  }
} catch (error) {
  problems.push(`package.json 读不动：${error.message}`)
}

if (problems.length > 0) {
  console.error('\n❌ 发现问题：')
  for (const problem of problems) console.error('  ·', problem)
  console.error('\n恢复片段见 docs/RECOVERY-profile-config.md')
  process.exit(1)
}
console.log('\n✅ profile patch 正常')
