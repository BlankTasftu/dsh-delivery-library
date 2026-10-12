/**
 * dsh-delivery-library —— 浏览器半侧（视图本体）。
 *
 * ─── 这个文件为什么是"手写产物"而不是打包结果 ──────────────────────────────
 * DSH 的客户端模块系统只认一种形态：`window.__ModuleLoader__.load({ id, factory })`。
 * 执行它只**注册** factory，模块副作用留到真正被 import 时。`dsh.client.platform
 * = 'web'` 指向本文件，宿主在 `/plugins/dsh-delivery-library/` 下按包名提供它。
 * 因此这里没有 `import`，只有 `require`（而且只能 require 基座里有的东西：本插件
 * 只 require `react`）。
 *
 * ─── 它往哪个座位放东西 ────────────────────────────────────────────────────
 * **对话窗的 View 页签**。`conversation.view` 是 ui-conversation 声明的 list 座位，
 * 出厂的 `chat`（对话，order 0）与 `trajectory`（轨迹，order 10）各占一格；本插件
 * 用一个新的 id（`delivery-library`，order 20）往里加第三格 —— 一个**全新 id 会被
 * 追加为相邻的一格**，不会顶掉出厂的两格（复用一个出厂 id 才会替换它，所以本插件
 * 刻意不这么做）。
 *
 *   座位契约（cordis Inspect 的 conversation.view catalog）：
 *     registration: { id（必填）, order, label: string | (() => string) }
 *     ownerProps:   { inspectCall, viewRequest, openView, completeViewRequest }
 *     standardProps: useSession / useChat / useConversation / useProjection /
 *                    useSessions / useResource / sessionId / …
 *   本插件只用到 ownerProps 之外的 `useSessions`（取会话工作目录，可选）与
 *   `inject(sessionId)` 传进来的自有 props。
 *
 * ─── 数据从哪来（这是本插件最关键的取舍）──────────────────────────────────
 * **不读磁盘、不扫工作区、不新增宿主路由**。交付清单完全由**当前会话已载入的
 * 事件窗口**折叠而来：
 *
 *   `ctx.sessions.binding(sessionId).eventSource`
 *     → `getSnapshot()` 给一个窗口 `{ revision, change: { kind, entries }, hasMore }`
 *         · kind === 'replace'：entries 是**全量**已载入窗口（首次 / 断档重建）
 *         · kind === 'append' ：entries 是新增的尾部增量
 *         · kind === 'prepend'：entries 是向前补页拿到的更早增量
 *     → 折叠两种事件：
 *         · `deliverables/presented`（宿主 present 工具 append 的交付声明）
 *             data = { turn, callId, files: [{ path, description? }] }
 *         · `tool/call` + `tool/result`（write / edit / str_replace_editor 的产出）
 *             与出厂 ui-deliverables 同一套判据：只认成功的第一方改动调用
 *
 * 这样做的好处：
 *   · 会话文件是"当前正在看的那个会话"的唯一真源，客户端已经拿到，无需二次读取；
 *   · 不依赖聊天节点窗口（那条路只覆盖已渲染的轮次，且随视图窗口滚动而变化）；
 *   · 出厂 ui-deliverables 的 delivery 卡片就是匹配同一批事件渲染的，口径一致。
 *
 * ─── 已知边界 ──────────────────────────────────────────────────────────────
 * · 清单覆盖**已载入**的会话历史；会话很长而客户端只载入了尾部时，窗口的
 *   `hasMore` 为 true，视图底部给出「加载更早」按钮（走 `session.loadOlder()`）。
 * · 交付 = 模型用 `present` 显式声明的文件；仅被 write/edit 写出的文件归到
 *   「产出」页签，两页签分开，不混为一谈。
 */

window.__ModuleLoader__.load({
  id: 'dsh-delivery-library',

  factory: (require) => {
    var __modules = Object.create(null)
    var __cache = Object.create(null)

    __modules['./index.js'] = function (module, exports, require, __load_) {
      'use strict'
      Object.defineProperty(exports, '__esModule', { value: true })

      const React = require('react')

      // ═══════════════════════════════════════════════════════════ 常量

      /** i18n 命名空间（同时是 slot 的 locale 名）。 */
      const NS = 'deliveryLibrary'
      /** 本 bundle 的包名（客户端模块身份，必须等于 __ModuleLoader__.load 的 id）。 */
      const PACKAGE_NAME = 'dsh-delivery-library'
      /** 视图座位里的格子 id —— 必须是新 id，才会**追加**而不是顶掉出厂视图。 */
      const VIEW_ID = 'delivery-library'
      /** 页签顺序：chat 0、trajectory 10，本视图排在其后。 */
      const VIEW_ORDER = 20
      /** 样式幂等标记。 */
      const CSS_TAG_ID = PACKAGE_NAME + '/styles'
      /** 交付声明事件（present 工具在 tools/result 时由宿主 append）。 */
      const DELIVERED_EVENT = 'deliverables/presented'
      /** 资源地址前缀：`dsh-resource://file/session/<sid>/<path>`。 */
      const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
      /** 两个页签。 */
      const TAB_DELIVERED = 'delivered'
      const TAB_PRODUCED = 'produced'
      /** 会话绑定还没建好时的重试节奏与上限（500ms × 240 = 2 分钟封顶）。 */
      const RETRY_INTERVAL_MS = 500
      const RETRY_ATTEMPTS = 240
      /** 复制反馈的自动复位时长。 */
      const COPY_FEEDBACK_MS = 2000
      /** 不需要 workspace 快照时的空 hook。 */
      const NO_WORKSPACES = function useNoWorkspaces() {
        return undefined
      }

      // ═══════════════════════════════════════════════════════ 纯工具函数

      /**
       * 归一化路径，用作"同一个文件"的判据。
       *
       * 只做形状归一（反斜杠、`./` 前缀、多余尾斜杠），**不**做大小写折叠：
       * 大小写敏感的文件系统上 `A.md` 与 `a.md` 是两个文件，猜错会把两个交付
       * 合成一行。展示与打开仍用模型原始拼写。
       *
       * @param value - 原始路径。
       * @returns 归一化后的键；无法用作键时返回空串。
       */
      function normalizeKey(value) {
        if (typeof value !== 'string') return ''
        let key = value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
        while (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1)
        return key.trim()
      }

      /**
       * 路径最后一段。
       * @param value - 路径。
       * @returns 文件名。
       */
      function basenameOf(value) {
        const normalized = String(value == null ? '' : value).replace(/\\/g, '/')
        return normalized.slice(normalized.lastIndexOf('/') + 1)
      }

      /**
       * 路径的目录部分（用于行内第二行小字）。
       * @param value - 路径。
       * @returns 目录，没有目录时为 `''`。
       */
      function dirnameOf(value) {
        const normalized = String(value == null ? '' : value).replace(/\\/g, '/')
        const at = normalized.lastIndexOf('/')
        return at <= 0 ? '' : normalized.slice(0, at)
      }

      /**
       * 扩展名（小写，不含点）。
       * @param value - 路径。
       * @returns 扩展名或空串。
       */
      function extensionOf(value) {
        const name = basenameOf(value)
        const dot = name.lastIndexOf('.')
        if (dot <= 0 || dot === name.length - 1) return ''
        return name.slice(dot + 1).toLowerCase()
      }

      /**
       * 文件图标上那两三个字母。
       * @param value - 路径。
       * @returns 扩展名大写，过长或无扩展名时退化为 `FILE`。
       */
      function labelOfExtension(value) {
        const extension = extensionOf(value)
        if (extension === '') return 'FILE'
        return extension.length <= 4 ? extension.toUpperCase() : extension.slice(0, 3).toUpperCase()
      }

      /**
       * 解析工具参数。事件里的 `arguments` 通常是模型产出的 JSON 字符串，
       * 但也可能是已经解析好的对象（不同链路编码不同），两种都收。
       * @param raw - 原始参数。
       * @returns 参数对象，或 null。
       */
      function parseArguments(raw) {
        if (raw === null || raw === undefined) return null
        if (typeof raw === 'object' && Array.isArray(raw) === false) return raw
        if (typeof raw !== 'string') return null
        try {
          const parsed = JSON.parse(raw)
          return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false
            ? parsed
            : null
        } catch (_error) {
          return null
        }
      }

      /** 非空字符串才算路径（与出厂 ui-deliverables 的 pathValue 同判据）。 */
      function pathValue(value) {
        return typeof value === 'string' && value.trim().length > 0 ? value : null
      }

      /** 非空字符串才算说明：空串归一成 undefined，下游只判断"有没有说明"。 */
      function cleanDescription(value) {
        return typeof value === 'string' && value !== '' ? value : undefined
      }

      /** `edit` 的必填字段。 */
      function validEditArgs(args) {
        return (
          typeof args.old_string === 'string' &&
          args.old_string.length > 0 &&
          typeof args.new_string === 'string' &&
          args.old_string !== args.new_string &&
          (args.replace_all === undefined || typeof args.replace_all === 'boolean')
        )
      }

      /** 只有完整的改写命令才算产出。 */
      function editorMutationPath(args) {
        const path = pathValue(args.path)
        if (path === null) return null
        switch (args.command) {
          case 'create':
            return typeof args.file_text === 'string' ? path : null
          case 'str_replace':
            return typeof args.old_str === 'string' &&
              args.old_str.length > 0 &&
              (args.new_str === undefined || typeof args.new_str === 'string')
              ? path
              : null
          case 'insert':
            return typeof args.insert_line === 'number' &&
              Number.isInteger(args.insert_line) &&
              args.insert_line >= 0 &&
              typeof args.new_str === 'string'
              ? path
              : null
          default:
            return null
        }
      }

      /**
       * 从一次第一方改动调用里取目标路径。
       *
       * 判据与出厂 `ui-deliverables` 的 `mutationPath` 一致：只认 write / edit /
       * 完整改写的 str_replace_editor。读、删除、不受支持的工具、参数残缺的调用
       * 一律不贡献条目 —— 宁缺毋滥，清单里出现的路径必须真的被写成了。
       *
       * @param name - 工具名。
       * @param rawArguments - 原始参数。
       * @returns 目标路径，或 null。
       */
      function mutationPath(name, rawArguments) {
        const args = parseArguments(rawArguments)
        if (args === null) return null
        switch (name) {
          case 'write':
            return typeof args.content === 'string' ? pathValue(args.file_path) : null
          case 'edit':
            return validEditArgs(args) ? pathValue(args.file_path) : null
          case 'str_replace_editor':
            return editorMutationPath(args)
          default:
            return null
        }
      }

      /**
       * 交付声明事件的形状校验（照抄出厂判据，避免把畸形事件渲染成卡片）。
       * @param value - 事件 data。
       * @returns 是否是合法交付声明。
       */
      function isDeliveredData(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
        const { turn, files } = value
        return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 1 && Array.isArray(files)
      }

      /** 单条交付声明的形状校验。 */
      function isDeliveredFile(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
        const { path, description } = value
        return (
          typeof path === 'string' &&
          path.trim().length > 0 &&
          (description === undefined || typeof description === 'string')
        )
      }

      // ═══════════════════════════════════════════ 事件窗口 → 清单（纯函数）

      /**
       * 把一段事件条目折叠成记录。
       *
       * 事件条目有两种形态：外层 entry 携带 `{ event }`（DSH 客户端 feed 的形态，
       * 外层 type 区分持久与瞬态），也可能直接就是事件本身 —— 两种都收。
       *
       * `tool/call` 与 `tool/result` 可能落在**不同的增量窗口**里（一次 append 只
       * 带来调用、下一次才带来结果），所以调用待配对表由调用方持有并跨窗口传递。
       *
       * @param entries - 事件条目数组。
       * @param pending - callId → { path, turn } 的待配对表（会被本函数就地更新）。
       * @returns 记录数组：`{ kind, path, description?, turn, seq }`。
       */
      function parseEntries(entries, pending) {
        const records = []
        if (!Array.isArray(entries)) return records
        for (const rawEntry of entries) {
          const entry = rawEntry !== null && typeof rawEntry === 'object' && rawEntry.event !== undefined ? rawEntry.event : rawEntry
          if (entry === null || typeof entry !== 'object') continue
          const type = entry.type
          const data = entry.data
          const seq = typeof entry.seq === 'number' ? entry.seq : Number.MAX_SAFE_INTEGER

          if (type === DELIVERED_EVENT) {
            if (!isDeliveredData(data)) continue
            for (const file of data.files) {
              if (!isDeliveredFile(file)) continue
              records.push({
                kind: 'delivered',
                path: file.path,
                description: cleanDescription(file.description),
                turn: data.turn,
                seq,
              })
            }
            continue
          }

          if (type === 'tool/call') {
            if (data === null || typeof data !== 'object') continue
            const callId = String(data.callId === undefined ? '' : data.callId)
            if (callId === '') continue
            const path = mutationPath(String(data.name === undefined ? '' : data.name), data.arguments)
            if (path === null) pending.delete(callId)
            else pending.set(callId, { path, turn: typeof data.turn === 'number' ? data.turn : undefined })
            continue
          }

          if (type === 'tool/result') {
            if (data === null || typeof data !== 'object') continue
            const message = data.message
            if (message === null || typeof message !== 'object') continue
            const source = message.source
            const callId = source !== null && typeof source === 'object' ? String(source.callId === undefined ? '' : source.callId) : ''
            if (callId === '') continue
            const call = pending.get(callId)
            if (call === undefined) continue
            pending.delete(callId)
            // 失败的调用不产出任何东西 —— 与卡片口径一致。
            if (message.isError === true) continue
            records.push({ kind: 'produced', path: call.path, turn: call.turn, seq })
          }
        }
        return records
      }

      /**
       * 记录 → 去重后的两栏清单。
       *
       * 同一个路径多次出现时合成一行：保留**最近一次**的非空说明（"重复声明使用
       * 最近一次的说明"），累计次数，轮次取首次出现的那一轮（它是什么时候进库的）。
       * 行序按首次出现的 seq 升序，也就是会话自身的时间顺序。
       *
       * @param records - parseEntries 产出的记录。
       * @param hasMore - 会话是否还有更早的历史未载入。
       * @returns `{ delivered, produced, hasMore }`。
       */
      function deriveLibrary(records, hasMore) {
        const delivered = new Map()
        const produced = new Map()
        for (const record of records) {
          const key = normalizeKey(record.path)
          if (key === '') continue
          const bucket = record.kind === 'delivered' ? delivered : produced
          const previous = bucket.get(key)
          if (previous === undefined) {
            bucket.set(key, {
              path: record.path,
              key,
              description: cleanDescription(record.description),
              turn: record.turn,
              count: 1,
              seq: record.seq,
            })
            continue
          }
          previous.path = record.path
          previous.count += 1
          const description = cleanDescription(record.description)
          if (description !== undefined) previous.description = description
        }
        const bySeq = (left, right) => left.seq - right.seq || (left.key < right.key ? -1 : 1)
        return {
          delivered: [...delivered.values()].sort(bySeq),
          produced: [...produced.values()].sort(bySeq),
          hasMore: hasMore === true,
        }
      }

      /** 空清单（也是"没有事件源"时的稳定返回值）。 */
      const EMPTY_LIBRARY = Object.freeze({
        delivered: Object.freeze([]),
        produced: Object.freeze([]),
        hasMore: false,
        available: false,
      })

      /**
       * 会话事件窗口 → 可订阅的清单快照。
       *
       * 窗口只有"变化"这一种形态，所以这里按 revision 增量折叠：
       * replace（首帧 / 断档重建）重算全量，append 接在尾部，prepend 接在头部。
       * `getSnapshot()` 必须返回**引用稳定**的值（React 的 useSyncExternalStore
       * 会用它判等），因此只在 revision 前进时才重建对象。
       *
       * @param resolveSource - 事件源，或"取事件源的函数"。传函数是为了让会话绑定
       *   晚于视图挂载时能**自愈**：每次读/订阅都会重新解析一次，绑定一出现就接上。
       * @returns `{ getSnapshot, subscribe, available }`。
       */
      function createLibraryStore(resolveSource) {
        const resolve = typeof resolveSource === 'function' ? resolveSource : () => resolveSource
        let source
        let records = []
        let pending = new Map()
        let revision
        let lastWindow
        let initialized = false
        let snapshot = EMPTY_LIBRARY

        /** 惰性解析事件源；解析到就固定下来（同一会话的 binding 是 identity 稳定的）。 */
        const currentSource = () => {
          if (source === undefined || source === null) {
            const next = resolve()
            if (next !== undefined && next !== null) source = next
          }
          return source
        }

        const readWindow = () => {
          const held = currentSource()
          if (held === undefined || typeof held.getSnapshot !== 'function') return undefined
          try {
            return held.getSnapshot()
          } catch (_error) {
            return undefined
          }
        }

        const sync = () => {
          const window = readWindow()
          if (window === undefined || window === null) return
          // 两道判等缺一不可：
          //   · 身份判等 —— 事件源每次 publish 都会给出**新的**窗口对象，所以同一个对象
          //     必然代表"没有新变化"。它保证 getSnapshot() 的返回值引用稳定，而这是
          //     React useSyncExternalStore 的硬要求（不稳定会变成无限重渲染）。
          //   · revision 判等 —— 兜住"同一个对象被就地改写"的实现（真实实现不会）。
          // 只留 revision 一道是有风险的：万一某个来源不带 revision，getSnapshot() 就会
          // 每次返回新对象，直接把页面拖进渲染循环。所以身份判等在这里是安全网。
          if (initialized && window === lastWindow) return
          const windowRevision = typeof window.revision === 'number' ? window.revision : undefined
          if (initialized && windowRevision !== undefined && windowRevision === revision) return
          const change = window.change
          const kind = change !== undefined && change !== null && typeof change.kind === 'string' ? change.kind : 'replace'
          // 窗口同时带两样东西（这是 dsh-api-session-controller 的 MutableSessionEventSource
          // 契约）：`entries` 是**完整已载入窗口**（惰性 materialize），`change.entries` 才是
          // 本次增量。两者用途不同，读错任一个都会出错：
          //   · 重建（首帧 / replace / 任何非 append|prepend 的帧，例如 settle-assistant）
          //     必须用 `window.entries` —— 否则首帧落在增量窗口上时会把历史整段丢掉，
          //     而 settle-assistant 压根没有 change.entries，用增量语义会重复累计。
          //   · 增量（append / prepend）用 `change.entries`，避免每次都为整个会话
          //     materialize 一遍（长会话上是 O(n)）。
          const full = Array.isArray(window.entries) ? window.entries : undefined
          const delta = change !== undefined && change !== null && Array.isArray(change.entries) ? change.entries : undefined
          const incremental = initialized && (kind === 'append' || kind === 'prepend')
          if (!incremental) {
            // 全量帧：待配对表必须一起重置，否则旧窗口的 tool/call 会串进新窗口。
            pending = new Map()
            records = parseEntries(full !== undefined ? full : delta !== undefined ? delta : [], pending)
          } else {
            const parsed = parseEntries(delta !== undefined ? delta : [], pending)
            records = kind === 'prepend' ? parsed.concat(records) : records.concat(parsed)
          }
          initialized = true
          revision = windowRevision
          lastWindow = window
          const derived = deriveLibrary(records, window.hasMore === true)
          snapshot = {
            delivered: derived.delivered,
            produced: derived.produced,
            hasMore: derived.hasMore,
            available: true,
          }
        }

        return {
          get available() {
            return currentSource() !== undefined
          },
          getSnapshot() {
            sync()
            return snapshot
          },
          subscribe(listener) {
            const held = currentSource()
            if (held === undefined || typeof held.subscribe !== 'function') {
              // 绑定还没建好：挂一个轻量重试，等它出现就接上，避免视图永久停在错误态。
              // 有上限：真拿不到（会话被关掉等）就停，不留一个永远跑的定时器。
              let attempts = 0
              const timer = setInterval(() => {
                if (currentSource() !== undefined) {
                  clearInterval(timer)
                  sync()
                  listener()
                  return
                }
                attempts += 1
                if (attempts >= RETRY_ATTEMPTS) clearInterval(timer)
              }, RETRY_INTERVAL_MS)
              if (typeof timer.unref === 'function') timer.unref()
              return () => clearInterval(timer)
            }
            sync()
            let dispose
            try {
              dispose = held.subscribe(() => {
                sync()
                listener()
              })
            } catch (_error) {
              return () => {}
            }
            return () => {
              try {
                if (typeof dispose === 'function') dispose()
              } catch (_error) {
                /* 释放失败不该冒泡到 React 的卸载路径 */
              }
            }
          },
        }
      }

      // ═══════════════════════════════════════════════════════ 资源地址 / 打开

      /** 逐段编码，保留盘符里的字面冒号（与出厂实现一致）。 */
      function encodeSegment(segment) {
        return encodeURIComponent(segment).replace(/%3A/gi, ':')
      }

      /** 按 `/` 分段编码。 */
      function encodePath(path) {
        return path.split('/').map(encodeSegment).join('/')
      }

      /** 会话作用域的文件地址。 */
      function sessionFileAddress(sessionId, path) {
        const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
        return FILE_ADDRESS_PREFIX + 'session/' + encodeSegment(String(sessionId)) + '/' + encodePath(normalized)
      }

      /** 是否带盘符 / UNC 前缀（Windows 口径）。 */
      function isWindowsStylePath(value) {
        return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith('\\\\')
      }

      /** 是否绝对路径（两种拼法都认）。 */
      function isAbsolutePath(path) {
        return path.startsWith('/') || isWindowsStylePath(path)
      }

      /**
       * 把调用方手里的路径变成会话作用域的资源地址。
       *
       * 相对路径直接用；绝对路径若落在会话工作目录内，则折成工作目录相对形式
       * （这样工作区被移动后仍能重新定位）；工作目录未知或路径在工作区之外时，
       * 保留绝对路径交给同一个会话地址 —— 与出厂 ui-deliverables 的判据一致。
       *
       * @param sessionId - 会话 id。
       * @param cwd - 会话工作目录，未知时传 undefined。
       * @param path - 绝对或工作区相对路径。
       * @returns `dsh-resource://file/…` 地址。
       */
      function fileAddressFor(sessionId, cwd, path) {
        const normalized = String(path).replace(/\\/g, '/')
        if (!isAbsolutePath(normalized)) return sessionFileAddress(sessionId, normalized)
        const root = typeof cwd === 'string' ? cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
        if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
        if (root !== '' && normalized.startsWith(root + '/')) {
          return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
        }
        return sessionFileAddress(sessionId, normalized)
      }

      /**
       * 取右栏服务。
       *
       * 刻意**不写进 `inject`**：`sidebarRight` 不是核心服务，把它列为硬依赖会让
       * 本插件在缺少右栏的组合里整个不挂载。这里按可选依赖处理 —— 拿不到就退化成
       * "复制路径"，视图本身照常可用。
       *
       * @param ctx - 客户端上下文。
       * @returns 右栏服务或 undefined。
       */
      function resolveSidebarRight(ctx) {
        try {
          if (typeof ctx.get === 'function') {
            const service = ctx.get('sidebarRight')
            if (service !== undefined && service !== null) return service
          }
        } catch (_error) {
          /* 未注册/未注入：走下面的退化路径 */
        }
        try {
          return ctx.sidebarRight
        } catch (_error) {
          return undefined
        }
      }

      /**
       * 在右侧栏打开一个文件。
       * @param sidebarRight - 右栏服务。
       * @param sessionId - 会话 id。
       * @param cwd - 会话工作目录。
       * @param path - 文件路径。
       * @returns 是否已经发起打开。
       */
      function openFileInSidebar(sidebarRight, sessionId, cwd, path) {
        if (sidebarRight === undefined || sidebarRight === null) return false
        const address = fileAddressFor(sessionId, cwd, path)
        try {
          if (typeof sidebarRight.openResourceIn === 'function') {
            sidebarRight.openResourceIn(sessionId, address)
            return true
          }
          if (typeof sidebarRight.openResource === 'function') {
            sidebarRight.openResource(address)
            return true
          }
        } catch (error) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[dsh-delivery-library] 打开侧栏预览失败：', error)
          }
        }
        return false
      }

      /** 复制文本到剪贴板（无剪贴板时返回 false）。 */
      function copyText(text) {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
        if (clipboard === undefined || clipboard === null || typeof clipboard.writeText !== 'function') return false
        try {
          const done = clipboard.writeText(text)
          if (done !== undefined && typeof done.then === 'function') done.then(undefined, () => {})
          return true
        } catch (_error) {
          return false
        }
      }

      // ═══════════════════════════════════════════════════════════════ 样式

      const CSS = [
        '.dshdl-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',
        '.dshdl-head{flex:none;display:flex;flex-direction:column;gap:10px;padding:14px 16px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
        '.dshdl-titleRow{display:flex;align-items:baseline;gap:8px;min-width:0}',
        '.dshdl-title{font-size:14px;font-weight:600;line-height:20px}',
        '.dshdl-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshdl-tools{display:flex;align-items:center;gap:8px}',
        '.dshdl-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);flex:none}',
        '.dshdl-segBtn{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
        '.dshdl-segBtn:hover{color:var(--dsw-alias-label-primary)}',
        '.dshdl-segBtn[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}',
        '.dshdl-count{font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
        '.dshdl-segBtn[data-active="true"] .dshdl-count{color:var(--dsw-alias-brand-primary)}',
        '.dshdl-search{flex:1;min-width:0;height:26px;padding:0 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}',
        '.dshdl-search:focus{border-color:var(--dsw-alias-brand-primary)}',
        '.dshdl-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px;padding:8px 10px 16px}',
        '.dshdl-row{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:10px;border:.5px solid transparent;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}',
        '.dshdl-row:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}',
        '.dshdl-row:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}',
        '.dshdl-tile{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);font-size:10px;font-weight:700;letter-spacing:.02em}',
        '.dshdl-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.dshdl-name{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshdl-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshdl-path{font-family:var(--ds-font-family-code,ui-monospace,Menlo,Consolas,monospace);font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary);opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshdl-meta{flex:none;display:flex;align-items:center;gap:6px}',
        '.dshdl-badge{flex:none;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:10px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}',
        '.dshdl-copy{flex:none;height:26px;padding:0 9px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;opacity:0}',
        '.dshdl-row:hover .dshdl-copy,.dshdl-copy:focus-visible{opacity:1}',
        '.dshdl-copy[data-ok="true"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
        '.dshdl-copy[data-ok="false"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
        '.dshdl-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:40px 24px;text-align:center}',
        '.dshdl-emptyTitle{font-size:13px;font-weight:600}',
        '.dshdl-emptyBody{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);max-width:420px}',
        '.dshdl-foot{flex:none;display:flex;align-items:center;gap:10px;padding:8px 16px;border-top:.5px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}',
        '.dshdl-footText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshdl-btn{flex:none;height:24px;padding:0 10px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;cursor:pointer}',
        '.dshdl-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
        '.dshdl-btn:disabled{opacity:.5;cursor:default}',
        '.dshdl-warn{color:var(--dsw-alias-state-warn-primary)}',
      ].join('')

      /** 注入一次样式（带 data-plugin-css 幂等标记，与出厂渲染器同款做法）。 */
      function ensureStyles() {
        if (typeof document === 'undefined') return
        // ⚠️ 引号只能来自 JSON.stringify 一处。写成 '"' + JSON.stringify(x) + '"' 会得到
        //    style[data-plugin-css=""x""] —— **非法选择器**，querySelector 直接抛
        //    SyntaxError。在浏览器里 apply 抛错 = 启动审计判定 failed = 桌面端退出进程
        //    （见 test/registration.test.mjs 的崩溃防护用例与 docs/DESIGN.md 的事故记录）。
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
        const style = document.createElement('style')
        style.dataset.plugin = PACKAGE_NAME
        style.dataset.pluginCss = CSS_TAG_ID
        style.textContent = CSS
        document.head.appendChild(style)
      }

      // ═══════════════════════════════════════════════════════════ 组件

      /**
       * 订阅外部 store。
       *
       * 优先用 React 自带的 useSyncExternalStore（18+ 都有）；万一基座给的是更老的
       * 运行时，退化成 useState + effect —— 两种路径的 hook 数量一致，不会因为
       * 运行时而改变 hook 顺序。
       *
       * @param store - `{ getSnapshot, subscribe }`。
       * @returns 当前快照。
       */
      function useStoreSnapshot(store) {
        if (typeof React.useSyncExternalStore === 'function') {
          return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
        }
        const [value, setValue] = React.useState(store.getSnapshot)
        React.useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), [store])
        return value
      }

      /** 一遍就查完的小写匹配。 */
      function matches(entry, needle) {
        if (needle === '') return true
        const haystack = (entry.path + '\n' + (entry.description === undefined ? '' : entry.description)).toLowerCase()
        return haystack.indexOf(needle) !== -1
      }

      /**
       * 一行文件。
       *
       * @param props - `{ entry, cwd, sessionId, openFile, t }`。
       * @returns 行元素。
       */
      function FileRow(props) {
        const { entry, t } = props
        const [copyState, setCopyState] = React.useState('idle')
        const directory = dirnameOf(entry.path)
        const description = entry.description !== undefined && entry.description !== '' ? entry.description : undefined
        // 有说明就用说明，没有说明才退回目录 —— 且两者都在时不重复显示同一段文字。
        const note = description !== undefined ? description : directory
        const showDirectory = directory !== '' && description !== undefined
        const openFile = typeof props.openFile === 'function' ? props.openFile : () => false

        // 反馈自动复位：否则"已复制"会一直挂在那儿，下次看会误以为是当前结果。
        React.useEffect(() => {
          if (copyState === 'idle') return undefined
          const timer = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS)
          if (typeof timer.unref === 'function') timer.unref()
          return () => clearTimeout(timer)
        }, [copyState])

        const open = () => {
          const opened = openFile(entry.path, props.cwd)
          // 没装右栏也不该让点击变成"没反应"：退化成复制路径，并给出提示。
          if (!opened) {
            setCopyState(copyText(entry.path) ? 'copied' : 'failed')
          }
        }

        const copy = (event) => {
          event.stopPropagation()
          event.preventDefault()
          setCopyState(copyText(entry.path) ? 'copied' : 'failed')
        }

        const onKeyDown = (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          open()
        }

        return React.createElement(
          'div',
          {
            className: 'dshdl-row',
            role: 'button',
            tabIndex: 0,
            title: entry.path,
            'aria-label': t('row.open', { name: entry.path }),
            onClick: open,
            onKeyDown: onKeyDown,
          },
          React.createElement('div', { className: 'dshdl-tile' }, labelOfExtension(entry.path)),
          React.createElement(
            'div',
            { className: 'dshdl-main' },
            React.createElement('div', { className: 'dshdl-name' }, basenameOf(entry.path)),
            note === '' ? null : React.createElement('div', { className: 'dshdl-note' }, note),
            showDirectory ? React.createElement('div', { className: 'dshdl-path' }, directory) : null,
          ),
          React.createElement(
            'div',
            { className: 'dshdl-meta' },
            entry.turn === undefined ? null : React.createElement('span', { className: 'dshdl-badge' }, t('row.turn', { turn: entry.turn })),
            entry.count > 1 ? React.createElement('span', { className: 'dshdl-badge' }, '×' + entry.count) : null,
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dshdl-copy',
              'data-ok': copyState === 'copied' ? 'true' : copyState === 'failed' ? 'false' : undefined,
              onClick: copy,
              title: t('row.copy'),
            },
            copyState === 'idle' ? t('row.copy') : copyState === 'copied' ? t('row.copied') : t('row.copyFailed'),
          ),
        )
      }

      /** 空态 / 搜索无结果。 */
      function Empty(props) {
        return React.createElement(
          'div',
          { className: 'dshdl-empty' },
          React.createElement('div', { className: 'dshdl-emptyTitle' }, props.title),
          React.createElement('div', { className: 'dshdl-emptyBody' }, props.body),
        )
      }

      /**
       * 视图本体：对话、轨迹之外的第三个页签。
       *
       * ownerProps（inspectCall / viewRequest / openView / completeViewRequest）本视图
       * 用不到 —— 它不做工具调用定位，也不接收焦点请求。用到的自有 props 由
       * `inject(sessionId)` 提供：`library` / `sessionId` / `openFile` / `loadOlder`。
       *
       * @param props - 标准 props + 自有 props。
       * @returns 视图元素。
       */
      function DeliveryLibraryView(props) {
        const t = props.t
        const library = props.library
        const sessionId = props.sessionId
        const useSessions = typeof props.useSessions === 'function' ? props.useSessions : NO_WORKSPACES
        // 工作目录只影响"绝对路径能否折成工作区相对形式"，拿不到也不影响打开。
        const cwd = useSessions((snapshot) =>
          snapshot !== undefined && snapshot !== null && snapshot.byId !== undefined
            ? snapshot.byId[sessionId] === undefined
              ? undefined
              : snapshot.byId[sessionId].cwd
            : undefined,
        )
        const state = useStoreSnapshot(library)
        const [tab, setTab] = React.useState(TAB_DELIVERED)
        const [query, setQuery] = React.useState('')
        const [older, setOlder] = React.useState('idle')

        const delivered = state.delivered
        const produced = state.produced
        const rows = tab === TAB_DELIVERED ? delivered : produced
        const needle = query.trim().toLowerCase()
        const visible = React.useMemo(() => {
          if (needle === '') return rows
          return rows.filter((entry) => matches(entry, needle))
        }, [rows, needle])

        const loadOlder = () => {
          setOlder('loading')
          let request
          try {
            request = props.loadOlder()
          } catch (_error) {
            request = undefined
          }
          if (request === undefined || request === null || typeof request.then !== 'function') {
            setOlder('idle')
            return
          }
          request.then(
            () => setOlder('idle'),
            () => setOlder('failed'),
          )
        }

        const tabButton = (id, label, count) =>
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dshdl-segBtn',
              'data-active': tab === id ? 'true' : 'false',
              onClick: () => setTab(id),
              'aria-pressed': tab === id ? 'true' : 'false',
            },
            label,
            React.createElement('span', { className: 'dshdl-count' }, String(count)),
          )

        const body =
          state.available === false
            ? React.createElement(Empty, { title: t('empty.noSession.title'), body: t('empty.noSession.body') })
            : visible.length === 0
              ? React.createElement(Empty, {
                  title: needle === '' ? t(tab === TAB_DELIVERED ? 'empty.delivered.title' : 'empty.produced.title') : t('empty.search.title'),
                  body: needle === '' ? t(tab === TAB_DELIVERED ? 'empty.delivered.body' : 'empty.produced.body') : t('empty.search.body'),
                })
              : visible.map((entry) =>
                  React.createElement(FileRow, {
                    key: entry.key,
                    entry,
                    cwd,
                    t,
                    openFile: props.openFile,
                  }),
                )

        return React.createElement(
          'div',
          { className: 'dshdl-root' },
          React.createElement(
            'div',
            { className: 'dshdl-head' },
            React.createElement(
              'div',
              { className: 'dshdl-titleRow' },
              React.createElement('div', { className: 'dshdl-title' }, t('view.title')),
              React.createElement(
                'div',
                { className: 'dshdl-sub' },
                t('view.summary', { delivered: delivered.length, produced: produced.length }),
              ),
            ),
            React.createElement(
              'div',
              { className: 'dshdl-tools' },
              React.createElement(
                'div',
                { className: 'dshdl-seg' },
                tabButton(TAB_DELIVERED, t('tab.delivered'), delivered.length),
                tabButton(TAB_PRODUCED, t('tab.produced'), produced.length),
              ),
              React.createElement('input', {
                className: 'dshdl-search',
                type: 'search',
                value: query,
                placeholder: t('search.placeholder'),
                'aria-label': t('search.placeholder'),
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
          ),
          React.createElement('div', { className: 'dshdl-body' }, body),
          React.createElement(
            'div',
            { className: 'dshdl-foot' },
            React.createElement('div', { className: 'dshdl-footText' }, t('foot.rule')),
            state.hasMore
              ? React.createElement(
                  'button',
                  { type: 'button', className: 'dshdl-btn', onClick: loadOlder, disabled: older === 'loading' },
                  older === 'loading' ? t('foot.loading') : t('foot.loadOlder'),
                )
              : null,
            older === 'failed'
              ? React.createElement('span', { className: 'dshdl-warn' }, t('foot.loadFailed'))
              : null,
          ),
        )
      }

      // ═══════════════════════════════════════════════════════════ 词典

      /** 简体中文（键集基准）。 */
      const zh = {
        'view.tab': '交付文件',
        'view.title': '交付文件库',
        'view.summary': '本会话：交付 {delivered} · 产出 {produced}',
        'tab.delivered': '交付',
        'tab.produced': '产出',
        'search.placeholder': '搜索文件名、路径或说明',
        'empty.delivered.title': '本会话还没有显式交付的文件',
        'empty.delivered.body': '交付来自 present 工具：模型把某个文件声明为最终交付时，它就会出现在这里。',
        'empty.produced.title': '本会话还没有写出或改过的文件',
        'empty.produced.body': '产出统计 write / edit 成功写出的文件；用终端命令创建的文件不会出现在这里。',
        'empty.search.title': '没有匹配的文件',
        'empty.search.body': '换一个关键词试试，搜索会同时匹配文件名、目录、说明。',
        'empty.noSession.title': '当前会话的事件流不可用',
        'empty.noSession.body': '视图没能拿到这个会话的事件源，清单无法计算。切换会话或重新打开页面后再试。',
        'row.open': '在右侧预览 {name}',
        'row.turn': '第 {turn} 轮',
        'row.copy': '复制路径',
        'row.copied': '已复制',
        'row.copyFailed': '复制失败',
        'foot.rule': '交付 = present 声明 · 产出 = write / edit 成功写出',
        'foot.loadOlder': '加载更早',
        'foot.loading': '载入中…',
        'foot.loadFailed': '加载失败',
      }

      /** English（与 zh 同键集）。 */
      const en = {
        'view.tab': 'Deliveries',
        'view.title': 'Delivery library',
        'view.summary': 'This session: {delivered} delivered · {produced} produced',
        'tab.delivered': 'Delivered',
        'tab.produced': 'Produced',
        'search.placeholder': 'Search name, path, or description',
        'empty.delivered.title': 'No explicitly delivered file in this session',
        'empty.delivered.body': 'Deliveries come from the present tool: a file appears here once the model declares it a final deliverable.',
        'empty.produced.title': 'No file written or edited in this session',
        'empty.produced.body': 'Produced files come from successful write / edit calls; files created by terminal commands are not listed here.',
        'empty.search.title': 'No matching file',
        'empty.search.body': 'Try another keyword: the search matches file name, directory, and description.',
        'empty.noSession.title': 'This session’s event stream is unavailable',
        'empty.noSession.body': 'The view could not obtain this session’s event source, so the list cannot be computed. Switch sessions or reload the page.',
        'row.open': 'Preview {name} on the right',
        'row.turn': 'Turn {turn}',
        'row.copy': 'Copy path',
        'row.copied': 'Copied',
        'row.copyFailed': 'Copy failed',
        'foot.rule': 'Delivered = present · Produced = successful write / edit',
        'foot.loadOlder': 'Load older',
        'foot.loading': 'Loading…',
        'foot.loadFailed': 'Load failed',
      }

      // ═══════════════════════════════════════════════════════════ 插件入口

      /**
       * 需要的客户端服务（**Cordis 服务名**，不是包名）。
       *
       * 只列真正必需的三个：`slots`（座位）、`locale`（词典）、`sessions`（会话事件源）。
       * 右栏 (`sidebarRight`) 是可选能力，按需在运行时取，不写进依赖表。
       */
      const inject = ['slots', 'locale', 'sessions']

      /**
       * 为一个会话准备视图 props。
       *
       * 拿不到会话绑定时不抛错 —— 返回一个"不可用"的 store，让视图渲染出可解释的
       * 空态，而不是让整个页签炸掉。
       *
       * @param ctx - 客户端上下文。
       * @param sessionId - 当前会话 id。
       * @returns 视图自有 props。
       */
      function createViewProps(ctx, sessionId) {
        /** 每次按需取会话绑定：绑定晚于视图挂载出现时也能接上。 */
        const bindingOf = () => {
          try {
            return typeof ctx.sessions.binding === 'function' ? ctx.sessions.binding(sessionId) : undefined
          } catch (error) {
            console.warn('[dsh-delivery-library] 会话绑定失败：', error)
            return undefined
          }
        }
        // 传函数而不是当次解析结果：会话绑定可能比视图挂载晚一步。
        const library = createLibraryStore(() => {
          const binding = bindingOf()
          return binding === undefined || binding === null ? undefined : binding.eventSource
        })

        return {
          library,
          sessionId,
          /**
           * 在右侧栏预览一个文件。
           * @param path - 文件路径。
           * @param cwd - 会话工作目录（标准 prop useSessions 换来）。
           * @returns 是否已经发起打开。
           */
          openFile: (path, cwd) => openFileInSidebar(resolveSidebarRight(ctx), sessionId, cwd, path),
          /**
           * 向前补页，把更早的会话事件载入窗口。
           * @returns 一个 Promise。
           */
          loadOlder: () => {
            const binding = bindingOf()
            const session = binding === undefined || binding === null ? undefined : binding.session
            if (session === undefined || session === null || typeof session.loadOlder !== 'function') {
              return Promise.resolve()
            }
            return session.loadOlder()
          },
        }
      }

      /**
       * 把异常压成一行短文本（诊断通道用）。
       * @param error - 任意抛出物。
       * @returns 单行、定长的描述。
       */
      function briefError(error) {
        const message =
          error !== null && error !== undefined && typeof error.message === 'string'
            ? error.message
            : String(error)
        const code = error !== null && error !== undefined && typeof error.code === 'string' ? error.code + ' ' : ''
        return (code + message).replace(/\s+/g, ' ').slice(0, 200)
      }

      /**
       * 把诊断文本写进一个**只读 Inspect 能读到**的通道。
       *
       * 为什么需要它：客户端插件的失败面在浏览器控制台里，而这个宿主（桌面端）既不
       * 保留渲染进程日志、也不把 client-modules 的失败详情写进崩溃日志 —— 崩溃日志里
       * 只有一句 `N entry did not activate`。座位账本是唯一一个"我能只读地看到"的
       * 客户端表面，所以把文本放进一个渲染为 null 的条目的 id 里。
       *
       * 全程 try/catch：诊断通道自己也绝不能抛错（那会回到崩溃的老问题）。
       *
       * @param ctx - 客户端上下文。
       * @param notes - 面包屑。
       */
      function reportDiagnostic(ctx, notes) {
        const id = PACKAGE_NAME + ' DIAG ' + notes.join(' | ')
        try {
          console.error(id)
        } catch (_error) {
          /* 标签式 console 不可用时只是少一条日志 */
        }
        const body = function Diagnostic() {
          return null
        }
        for (const slot of ['shell.overlay', 'sidebar.panellist']) {
          try {
            ctx.effect(() => ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id, order: 9999 }, body)), PACKAGE_NAME + ': 诊断')
            return
          } catch (_error) {
            try {
              ctx.slots.register({ name: slot, id, order: 9999 }, body)
              return
            } catch (_inner) {
              /* 换下一个座位 */
            }
          }
        }
      }

      /**
       * 挂载「交付文件」视图。
       *
       * ─── 为什么不惜代价做到"绝不抛错" ────────────────────────────────────────
       * 客户端的启动审计（dsh-web-frontend）会把**任何**未达 active 的插件条目当成
       * 致命错误：桌面端收到 `web boot: N entry did not activate` 后直接退出进程。
       * 也就是说：本插件在 `apply` 里抛出的任何异常 = 用户的 DSH 崩一次。
       * 所以这里每一步都单独兜住，最坏结果是"页签没出现"，绝不是"应用退出"。
       *
       * 失败时把面包屑写进一个**可被只读 Inspect 读到**的座位：往根作用域的
       * `shell.overlay`（list）注册一条渲染为 null 的条目，诊断文本就在条目 id 里。
       * 这条通道自身也全程 try/catch —— 它失败也绝不能冒泡。
       *
       * @param ctx - 浏览器半侧的 Cordis 上下文。
       */
      function apply(ctx) {
        const notes = []
        const step = (name, run) => {
          try {
            const value = run()
            notes.push(name + '=ok')
            return { ok: true, value }
          } catch (error) {
            notes.push(name + '=X(' + briefError(error) + ')')
            return { ok: false, error }
          }
        }

        step('styles', ensureStyles)
        step('locale', () => ctx.effect(() => ctx.locale.register(NS, { zh, en }), PACKAGE_NAME + ': 词典'))
        let t = (key) => key
        try {
          t = ctx.locale.bind(NS)
        } catch (error) {
          notes.push('bind=X(' + briefError(error) + ')')
        }
        step('spec', () => {
          const spec = typeof ctx.slots.spec === 'function' ? ctx.slots.spec('conversation.view') : undefined
          notes.push('spec=' + (spec === undefined ? 'undeclared' : String(spec.kind)))
        })

        // 自检（注册后立刻撤销，不留下可见产物）：把"注册为什么失败"缩小到具体选项。
        // 只在槽位**已经声明**时才有意义 —— 未声明时 register 必然抛 "not declared"，
        // 那个结论没有信息量（inject 会等声明）。
        let declared = false
        try {
          declared = typeof ctx.slots.spec === 'function' && ctx.slots.spec('conversation.view') !== undefined
        } catch (_error) {
          declared = false
        }
        const probe = (name, options) => {
          try {
            const dispose = ctx.slots.register({ name: 'conversation.view', ...options }, () => null)
            dispose()
            notes.push(name + '=ok')
          } catch (error) {
            notes.push(name + '=X(' + briefError(error) + ')')
          }
        }
        if (declared) {
          probe('p1', { id: 'dl-probe-1' })
          probe('p2', { id: 'dl-probe-2', order: VIEW_ORDER, locale: NS, label: () => 'probe' })
          probe('p3', { id: 'dl-probe-3', inject: () => ({}) })
        }

        const view = step('view', () =>
          // 不额外包一层 ctx.effect：ui-trajectory 就是直接调用，让 inject 自己持有
          // 那个控制器（它的 dispose 已经挂在调用方 fiber 上）。
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: VIEW_ID,
                order: VIEW_ORDER,
                locale: NS,
                // 用 thunk：切换语言时页签名跟着变，不需要重新注册。
                label: () => t('view.tab'),
                inject: (sessionId) => createViewProps(ctx, sessionId),
              },
              DeliveryLibraryView,
            ),
          ),
        )

        // 只要有任何一步失败（不只是视图注册），就把面包屑记进诊断通道 ——
        // 词典注册失败虽然不会让页签消失（文案会回落到 key），但那是需要被看见的降级。
        // 探测项（p1/p2/p3）只是信息，不算降级：视图都成了，探测失败没有报告价值。
        const degraded =
          !view.ok || notes.some((note) => note.indexOf('=X(') !== -1 && note.startsWith('p') === false)
        if (degraded) reportDiagnostic(ctx, notes)
      }

      exports.apply = apply
      exports.inject = inject
      exports.NS = NS
      exports.VIEW_ID = VIEW_ID
      exports.VIEW_ORDER = VIEW_ORDER
      /** 供单元测试直接调用的纯函数（浏览器运行时不会读它）。 */
      exports.__internals = {
        NS,
        VIEW_ID,
        VIEW_ORDER,
        normalizeKey,
        basenameOf,
        dirnameOf,
        extensionOf,
        mutationPath,
        parseEntries,
        deriveLibrary,
        createLibraryStore,
        fileAddressFor,
        sessionFileAddress,
        DeliveryLibraryView,
        dicts: { zh, en },
      }
      return module.exports
    }

    /** 相对请求解析（本 bundle 只有一个模块，保留与 dsh-ark 相同的骨架）。 */
    function __resolve(from, request) {
      if (!request.startsWith('.')) return request
      var parts = from.slice(2).split('/')
      parts.pop()
      for (var part of request.split('/')) {
        if (part === '.' || part === '') continue
        if (part === '..') parts.pop()
        else parts.push(part)
      }
      return './' + parts.join('/')
    }
    function __load(id) {
      if (__modules[id] === undefined) return require(id)
      if (__cache[id] !== undefined) return __cache[id].exports
      var module = (__cache[id] = { exports: {} })
      __modules[id](module, module.exports, require, function (request) {
        var resolved = __resolve(id, request)
        return __modules[resolved] === undefined ? require(request) : __load(resolved)
      })
      return module.exports
    }
    return __load('./index.js')
  },
})
