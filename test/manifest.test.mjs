/**
 * 清单一致性测试：包清单、bundle patch、客户端 bundle 三者必须自洽。
 *
 * 这几处一旦对不上，症状是"插件装了但页签不出现"，而且宿主不会报错 —— 所以用
 * 测试钉住：客户端模块 id、包名、bundle patch 的 name/id、exports["./client"]、
 * dsh.client.platform。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readClientSource } from './harness.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const clientSource = readClientSource()

test('客户端模块 id 等于包名（路由与模块表都按它索引）', () => {
  assert.match(clientSource, new RegExp(`id:\\s*'${pkg.name}'`))
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.equal(pkg.main, 'lib/index.js')
})

test('bundle patch 插入的正是本包，且 id 与包名一致', () => {
  assert.match(patch, /- insert:/)
  assert.match(patch, new RegExp(`id: ${pkg.name}`))
  assert.match(patch, new RegExp(`name: ${pkg.name}`))
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('宿主半侧是空实现（本插件在宿主上不做事）', () => {
  const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8')
  assert.match(host, new RegExp(`export const name = '${pkg.name}'`))
  assert.match(host, /export function apply\(\) \{\}/)
  assert.deepEqual(pkg.files.includes('docs') || pkg.files.includes('lib'), true)
})

test('要发货的文件清单覆盖两个半侧与 patch', () => {
  for (const entry of ['lib', 'cordis.patch.yml', 'README.md']) {
    assert.ok(pkg.files.includes(entry), `files 缺 ${entry}`)
  }
})

test('客户端 bundle 不 import、只 require 基座里的 react', () => {
  // 手写 bundle 的硬约束：没有 import 语句，require 只允许出现 react
  assert.doesNotMatch(clientSource, /^\s*import\s/m)
  const required = [...clientSource.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(required)], ['react'])
})

test('视图 id 与出厂视图不冲突，且排在它们之后', () => {
  const { exports } = (() => {
    const loaded = []
    new Function('window', clientSource)({ __ModuleLoader__: { load: (entry) => loaded.push(entry) } })
    return { exports: loaded[0].factory((specifier) => (specifier === 'react' ? {} : undefined)) }
  })()
  assert.equal(exports.VIEW_ID, 'delivery-library')
  assert.notEqual(exports.VIEW_ID, 'chat')
  assert.notEqual(exports.VIEW_ID, 'trajectory')
  assert.equal(exports.__internals.VIEW_ORDER, 20)
})
