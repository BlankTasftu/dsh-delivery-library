/**
 * 隔离性测试：把这个插件的"活动边界"钉死。
 *
 * 要证明的命题（用户要求）：
 *   **它只以插件形式运行，不对系统、DSH 本体、或任何第三方东西做修改。**
 *
 * 这些断言是静态的、可在 CI 里跑的 —— 也就是说，以后任何人往这个仓库里加了
 * "顺手读个文件/发个请求/改个别的插件配置"的代码，都会在这里当场失败。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { loadClientBundle } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 去掉注释后再做静态扫描：注释里出现 "process"/"path" 这类词不算能力。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const hostSource = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
const hostCode = stripComments(hostSource)
const clientSource = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const clientCode = stripComments(clientSource)
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ─────────────────────────────────────────────────────────────────────────────
// 宿主半侧：必须是"什么都不做"
// ─────────────────────────────────────────────────────────────────────────────

test('宿主半侧没有任何模块导入（连 node: 内置模块都没有）', () => {
  assert.doesNotMatch(hostCode, /^\s*import\s/m, 'lib/index.js 不应有任何 import')
  assert.doesNotMatch(hostCode, /\brequire\s*\(/, 'lib/index.js 不应有任何 require')
})

test('宿主半侧不碰任何平台能力（文件、进程、网络、环境、动态求值）', () => {
  const banned = [
    'fs', 'child_process', 'worker_threads', 'cluster', 'net', 'http', 'https', 'dns',
    'os', 'path', 'process', 'globalThis', 'eval', 'Function', 'fetch', 'WebSocket',
    'spawn', 'exec', 'execSync', 'registry', 'registryKey',
  ]
  for (const name of banned) {
    assert.doesNotMatch(
      hostCode,
      new RegExp(`\\b${name}\\b`),
      `lib/index.js 不应引用 ${name}`,
    )
  }
})

test('宿主半侧的 apply 是空实现，且调用它没有任何副作用', async () => {
  const namespace = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  assert.deepEqual(Object.keys(namespace).sort(), ['apply', 'inject', 'name'])
  assert.equal(namespace.name, 'dsh-delivery-library')
  assert.deepEqual(namespace.inject, [], '宿主半侧不应依赖任何服务')
  assert.match(hostCode, /export function apply\(\) \{\}/, 'apply 必须保持空实现')
  assert.equal(namespace.apply(), undefined)
})

// ─────────────────────────────────────────────────────────────────────────────
// 浏览器半侧：只做页面内的渲染，不联网、不落盘、不越权
// ─────────────────────────────────────────────────────────────────────────────

test('浏览器半侧只 require 基座里的 react，且没有 import 语句', () => {
  assert.doesNotMatch(clientCode, /^\s*import\s/m)
  const required = [...clientCode.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(required)], ['react'])
})

test('浏览器半侧不联网、不写任何存储、不做动态求值', () => {
  const banned = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'importScripts',
    'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookie',
    'eval', 'Function', 'document.write', 'window.open', 'location.href', 'location.assign',
    'replaceState', 'pushState',
  ]
  for (const name of banned) {
    assert.doesNotMatch(clientCode, new RegExp(name.replace('.', '\\.')), `lib/client.js 不应使用 ${name}`)
  }
})

test('浏览器半侧唯一的 DOM 写入是"注入一份带标记的样式"', () => {
  const writes = [...clientCode.matchAll(/document\.(\w+)/g)].map((match) => match[1])
  // 允许的文档 API：读选择器（幂等判断）、创建元素、访问 head
  assert.deepEqual([...new Set(writes)].sort(), ['createElement', 'head', 'querySelector'])
  // 样式带 data-plugin / data-plugin-css 标记，宿主卸载插件时按标记回收
  assert.match(clientCode, /style\.dataset\.plugin = PACKAGE_NAME/)
  assert.match(clientCode, /style\.dataset\.pluginCss = CSS_TAG_ID/)
})

test('浏览器半侧不读写任何文件：文件只能通过 DSH 的 dsh-resource 地址交给侧栏', () => {
  // 它只会**拼一个地址**，字节由宿主的资源服务去读
  assert.match(clientCode, /dsh-resource:\/\/file\//)
  const banned = ['readFile', 'writeFile', 'node:fs', 'blob', 'FileReader', 'createObjectURL']
  for (const name of banned) {
    assert.doesNotMatch(clientCode, new RegExp(name), `lib/client.js 不应使用 ${name}`)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 装载声明：只"插入自己"，绝不改动 DSH 或其它插件的任何条目
// ─────────────────────────────────────────────────────────────────────────────

test('bundle patch 只插入本插件自己这一行', () => {
  assert.match(patch, /^- insert:/m)
  // 全文件只允许出现一个 `- id:`，且必须是本包
  const ids = [...patch.matchAll(/^\s*- id:\s*(\S+)\s*$/gm)].map((match) => match[1])
  assert.deepEqual(ids, [pkg.name], 'patch 里应当只有本插件自己的 id')
  const names = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map((match) => match[1])
  assert.deepEqual(names, [pkg.name])
  // 不得出现"禁用/覆盖/隔离其它条目"的写法（那些才会改动 DSH 自身行为）
  for (const key of ['disabled', 'inject', 'isolate', 'group']) {
    assert.doesNotMatch(patch, new RegExp(`^\\s*${key}:`, 'm'), `patch 不应出现 ${key}`)
  }
  // 唯一的 id 行必须就是那个插入行的子项，不存在第二个顶层条目
  const topLevel = [...patch.matchAll(/^- (?!insert:)(\S+):/gm)].map((match) => match[1])
  assert.deepEqual(topLevel, [], 'patch 顶层只应有 insert')
})

test('package.json 不声明安装脚本、不依赖任何第三方运行时依赖', () => {
  assert.equal(pkg.scripts?.postinstall, undefined)
  assert.equal(pkg.scripts?.preinstall, undefined)
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.bin, undefined, '插件不应安装任何可执行入口')
})

test('插件只注册页面内的座位与词典，不注册任何宿主能力', () => {
  const { exports } = loadClientBundle()
  assert.deepEqual(exports.inject, ['slots', 'locale', 'sessions'])
  // 宿主半侧 exports 面已经在上面钉过；浏览器半侧只允许这一个座位注册
  assert.match(clientCode, /ctx\.slots\.inject\('conversation\.view'/)
  for (const name of ['ctx.tools', 'ctx.fs', 'ctx.http', 'ctx.sessions.provide', 'ctx.provide']) {
    assert.doesNotMatch(clientCode, new RegExp(name.replace('.', '\\.')), `不应注册 ${name}`)
  }
})
