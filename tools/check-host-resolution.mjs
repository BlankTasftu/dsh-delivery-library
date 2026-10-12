/**
 * 宿主装载检查：复刻 dsh-client-modules 的 `resolveMeta` 解析链，确认
 * 从 profile 目录出发能按同一套规则找到本插件的浏览器 bundle。
 *
 * 只读：解析 + 读 package.json + 检查文件存在。不写任何东西。
 *
 * 用法: node tools/check-host-resolution.mjs [profileDir]
 * 默认 profile 目录走环境变量 DSH_PROFILE_DIR（见 tools/paths.mjs）。
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { profileDir as defaultProfileDir } from './paths.mjs'

const profileDir = process.argv[2] ?? defaultProfileDir()
const packageName = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).name

const require = createRequire(pathToFileURL(join(profileDir, 'package.json')).href)

// ① Loader 行按模块说明符解析到 package.json（必须导出了 "./package.json"）
const pkgPath = require.resolve(`${packageName}/package.json`)
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

// ② dsh.client 声明
const decl = pkg.dsh?.client
if (decl === undefined) throw new Error(`${packageName} 没有 dsh.client 声明`)
if (decl.platform !== 'web') throw new Error(`${packageName} dsh.client.platform 必须是 'web'`)

// ③ exports["./client"] 指向的 bundle 必须真的存在
const clientRel = pkg.exports?.['./client']?.default
if (typeof clientRel !== 'string') throw new Error(`${packageName} 没有导出 "./client"`)
const clientPath = join(dirname(pkgPath), clientRel)
if (!existsSync(clientPath)) throw new Error(`客户端 bundle 不存在：${clientPath}`)

// ④ package.json 的 dsh.bundle.patch 也要存在（bundle 层的挂载声明）
const patchRel = pkg.dsh?.bundle?.patch
const patchPath = patchRel === undefined ? undefined : join(dirname(pkgPath), patchRel)
if (patchPath === undefined || !existsSync(patchPath)) throw new Error(`bundle patch 不存在：${patchPath}`)

// ⑤ 宿主入口可解析
const mainPath = require.resolve(packageName)
if (!existsSync(mainPath)) throw new Error(`宿主入口不可解析：${mainPath}`)

console.log('profile          :', profileDir)
console.log('package.json     :', pkgPath)
console.log('dsh.client       :', JSON.stringify(decl))
console.log('client bundle    :', clientPath, `(${readFileSync(clientPath, 'utf8').length} 字符)`)
console.log('bundle patch     :', patchPath)
console.log('host entry       :', mainPath)
console.log('OK: 宿主侧装载链完整')
