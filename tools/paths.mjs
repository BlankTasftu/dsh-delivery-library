/**
 * 探针共享的路径/地址解析。
 *
 * 这些工具的默认值**不能写死某一台机器**（原先是 D:\DeepSeekHarness\… 与
 * %USERPROFILE%\.dsh\profiles\desktop），否则换台电脑就只能改源码。统一走：
 *
 *   环境变量（优先）              回退
 *   DSH_WEB_URL                   http://127.0.0.1:19387
 *   DSH_PROFILE_DIR               $DSH_HOME/profiles/$DSH_PROFILE → %USERPROFILE%\.dsh\profiles\desktop
 *   DSH_ASAR_PATH                 常见安装位置（见 asarPath()）
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** DSH Web 服务的基地址。 */
export function webBaseUrl() {
  return process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'
}

/** `/plugins/events`（启动图 SSE）的完整地址。 */
export function webEventsUrl() {
  return new URL('/plugins/events', webBaseUrl()).href
}

/** 当前 profile 目录。 */
export function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const name = process.env.DSH_PROFILE ?? 'desktop'
  return join(home, 'profiles', name)
}

/** DSH 主机 app.asar 的路径（找不到时给出可操作的提示）。 */
export function asarPath(explicit) {
  if (explicit !== undefined && explicit !== null) return explicit
  if (process.env.DSH_ASAR_PATH) return process.env.DSH_ASAR_PATH
  const candidates = [
    // 默认安装位置
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    join(process.env.PROGRAMFILES ?? '', 'DeepSeek Harness', 'resources', 'app.asar'),
    // 自定义安装目录（本仓库作者机器上是这个；其他机器请用 --asar / DSH_ASAR_PATH）
    'D:\\DeepSeekHarness\\resources\\app.asar',
  ].filter((value) => value !== '')
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error(
    '找不到 app.asar —— 请用 --asar <path> 指定，或设置环境变量 DSH_ASAR_PATH。\n已尝试：\n  ' +
      candidates.join('\n  '),
  )
}
