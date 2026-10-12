# 设计说明：为什么是这条路

这份文档记录**决策与证据**，不是使用说明（那在 [README](../README.md)）。
写下它的理由：这个插件的每一处"没做什么"，都比"做了什么"更容易在后续维护里被
误改 —— 尤其是数据来源那一处。

## 1. 座位：追加一个新 id，而不是复用出厂的

`conversation.view` 是 ui-conversation 声明的 list 座位，出厂两格：

| id | order | 归属 |
| --- | --- | --- |
| `chat` | 0 | 对话 |
| `trajectory` | 10 | 轨迹（代码工作工具关闭时 shell 会隐藏它） |

座位目录里写得很清楚：

> Your cell key. Use an id of your own: **a fresh id is added beside the shipped
> entries, while reusing a shipped id puts you in THAT cell and replaces it.**

所以本插件用新 id `delivery-library`（order 20）。**不要**改成 `chat` 或 `trajectory`：
那会顶掉出厂的视图。`test/registration.test.mjs` 把这条钉住了。

注册用的是 ui-trajectory 的同款写法（`ctx.slots.inject` + `ctx.slots.register`，
组件接 ownerProps 之外的标准 props），挂在 `ctx.effect` 上，插件卸载即撤销。

## 2. 数据来源：会话事件窗口，而不是聊天节点、也不是磁盘

### 考虑过的三条路

| 方案 | 为什么没选 |
| --- | --- |
| 扫聊天节点（`useChat` 的 `nodes`/`order`） | 节点是**按已渲染轮次**组装的，随视图滚动窗口变化；"整个会话"的语义会被渲染状态绑架 |
| 宿主半侧读会话日志（`$DSH_HOME/sessions/*.jsonl`）或自建路由 | 要读工作区之外的磁盘、要自己维护 sessionId→文件映射；同一个事实在客户端已经有一份，没必要读第二遍 |
| **会话事件窗口**（选中） | 客户端本来就持有当前会话的事件流；`present` 的交付声明、`write`/`edit` 的调用与结果都在里面；出厂 delivery 卡片匹配的是同一批事件，口径天然一致 |

### 窗口契约（关键，且很容易读错）

`ctx.sessions.binding(sessionId).eventSource` 的快照同时带**两样东西**：

```ts
{
  entries: readonly Entry[]   // 完整已载入窗口（惰性 materialize，O(n)）
  hasMore: boolean            // 是否还有更早历史未载入
  revision: number            // 单调递增
  change: { kind, entries? }  // 本次变化
}
```

`change.kind` 有**四种**：`replace` / `prepend` / `append` / `settle-assistant`。
（前三种见 `MutableSessionEventSource.replace/prepend/append`，第四种见 `settleAssistant`。）

两个必须记住的结论：

1. **重建一律用 `window.entries`，增量才用 `change.entries`。**
   反过来会踩两个坑：视图挂载那一刻窗口的 `change` 可能已经是 `append`，
   这时若用 `change.entries` 当全量，前面所有历史交付会**整段消失**；
   而 `settle-assistant` 帧**根本没有** `change.entries`，把它当增量追加会
   **重复累计**（次数徽标变成 ×2、×4…）。`test/library.test.mjs` 里各有回归用例。
2. **`entries` 是惰性 getter**：只在重建帧碰它（长会话上是 O(n)），
   append 帧只吃增量。这也是"每来一个事件就整体重算"被避免的原因。

### 折叠口径

- 交付：`deliverables/presented`（`present` 工具成功后在 `tools/result` 里由宿主
  append，见 `dsh-tool-present/lib/index.js`），逐文件展开，带 `turn` 与可选 `description`。
- 产出：`tool/call` 记下 `callId → path`，等到 `tool/result` 且 `message.isError !== true`
  才计一条。`mutationPath` 的判据与出厂 `ui-deliverables` 逐条对齐（write 要有
  `content`、edit 要 `old_string !== new_string`、str_replace_editor 只认改写类命令）。
- 合并：按归一化路径去重，说明取最近一次非空值，轮次取首次，行序按首次出现的 `seq`。
- 跨帧配对：调用与结果可能落在两个增量帧里，所以待配对表挂在 store 上而不是单次解析里；
  重建帧会重置它（否则旧窗口的调用会串到新窗口）。

## 3. 可选依赖：右栏按"有则用、没有则退化"处理

`sidebarRight` **没有**写进 `inject`：它不是核心服务，列成硬依赖会让本插件在缺少
右栏的组合里整个不挂载。做法是运行时 `ctx.get('sidebarRight')`，拿不到就把点击
退化成"复制路径"。同理 `useSessions`（取会话工作目录，只影响绝对路径能否折成
工作区相对形式）也做了防护。

## 4. 证据与复现

### 契约来源（都是读出来的，不是猜的）

```powershell
# 只读地从 DSH 主机 app.asar 抽取内置包源码（用完的副本已删除，可随时重抽）
$NODE = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $NODE tools/asar-extract.mjs list    <asar> dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation
& $NODE tools/asar-extract.mjs extract <asar> .tmp-ref <prefix>…
```

读了 `dsh-client-ui-conversation`（座位与装配）、`dsh-client-ui-trajectory`（同款
视图注册）、`dsh-client-ui-deliverables`（同款取数与资源地址）、`dsh-tool-present`
（事件形状）、`dsh-api-session-controller`（事件窗口契约）、`dsh-client-modules`
（客户端 bundle 怎么被扫到、组合、投递）、`dsh-client-hmr`（图变更怎么推给页面）。

另外用 cordis Inspect 读了**活着的运行时**：`conversation.view` 的 catalog /
occupants / ownerProps / standardProps、客户端 Service 目录、主题 token 表。

### 本地验证

- `node --test "test/*.test.mjs"` → 39/39 通过（含上节两条窗口契约回归）。
- 测试直接执行 `lib/client.js` 本体（`test/harness.mjs` 复刻装载契约 + 迷你 React
  运行时），因此"注册了什么"和"渲染出什么"都是对发货文件本身的断言。

### 装载验证

- 宿主：`plugin_manager list_plugins` 出现 `include:dsh-delivery-library`，
  `fiberPhase: active`。
- 启动图（`tools/check-boot-graph.mjs`，只读 SSE 探针）：
  `entries/batches = 72/3`，本插件行在图中
  （`rev=e810ed80b2d2`，`inject=["@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-locale"]`），
  属于 `application` 批次；按批次 URL 实取 → **HTTP 200、1.4MB、含本插件代码、整段脚本可解析**。
  也就是说：从"宿主扫到 → 组合启动图 → 批次投递"这条链已经通到最后一跳。
- profile 解析链（`tools/check-host-resolution.mjs`）：从 profile 目录出发，
  `dsh-delivery-library/package.json` → `exports["./client"]` → `lib/client.js` 全部可解析。
- 浏览器（0.2.0 实测）：`conversation.view` 的 occupants =
  `chat(0) / trajectory(10) / delivery-library(20)`，三者都 `active`；
  同一页面的 `shell.overlay` 里**没有** `dsh-delivery-library DIAG` 条目
  —— 也就是应用过程每一步都没降级。
- 复现路径：**重新启用插件后不需要重启应用**。宿主把新的启动图经 `/plugins/events`
  SSE 推给已打开的页面（`dsh-client-hmr` → `ctx.modules.entries.sync(graph)`），
  页面随即物化并挂载新条目 —— 本次正是靠它把崩溃变成"可反复验证"。

## 5. 事故记录：一次把桌面端打崩的 `apply` 抛错（0.1.0 → 0.2.0）

### 症状

装好 0.1.0 后，DSH 桌面端**连续两次启动即退出**（13:41:50、13:42:08），应用数据目录里
留下崩溃日志：

```
%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-…-web-boot.log
--- error ---
Error: web boot: 1 entry did not activate
dsh-delivery-library: failed
```

### 机制（为什么一个前端插件能把整个应用带走）

渲染进程的启动审计（`dsh-web-frontend` 的 `eM()`）在**所有客户端条目结算后**逐条检查
fiber 状态，任何非 `active` 都汇总成一条错误；桌面端主进程的 `bootFailed` IPC 处理器
（`lib/main.js:11573`）把它交给 `reportFatal(..., 'web-boot')` —— **直接退出进程**。

判定文本区分三种情况：`import failed`（fiber 不存在）、`pending (waiting for service: …)`
（inject 未满足）、其余为状态名。拿到的是 `failed`，即 **`apply` 抛了异常**。

### 根因（一行代码）

```js
// 0.1.0（错）
document.querySelector('style[data-plugin-css="' + JSON.stringify(CSS_TAG_ID) + '"]')
//                                       ↑ 手写引号 + JSON.stringify 自带引号 = 双层
// 拼出来是 style[data-plugin-css=""dsh-delivery-library/styles""] —— 非法选择器
```

`querySelector` 抛 `SyntaxError: … is not a valid selector` → `ensureStyles()` 抛 → `apply`
抛 → fiber `failed` → 审计 → 桌面端退出。出厂 `dsh-media-preview` 的同一行是
`'style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']'`（引号只来自 JSON.stringify）。

### 为什么原有 40 个测试没抓到

Node 里没有 `document`，`ensureStyles()` 在 `typeof document === 'undefined'` 处**直接早返回** ——
那段代码在测试里一次都没被执行过。

### 修复与防复发

1. **修掉选择器**（引号只留一处）。
2. **`test/styles.test.mjs`**：造一个带**选择器校验**的 document 桩（非法选择器必须像真浏览器
   一样抛错），断言样式恰好注入一次、重复 apply 幂等、`querySelector` 抛错时 apply 不抛。
3. **`apply` 结构化到"绝不抛错"**：每一步单独 try/catch，任何一步失败都只降级、不冒泡。
4. **诊断通道**：失败时把面包屑（哪一步失败、异常文本、槽位是否已声明）写进 `shell.overlay`
   里一个渲染为 null 的条目 id —— 它是唯一一个"插件作者能只读看到"的客户端表面。
   本次就是靠它一次命中根因（`styles=X(...is not a valid selector) | … | view=ok`）。

### 这次事故留下的运行时契约

> **客户端插件的 `apply` 里任何未捕获异常 = 用户的桌面端退出一次。**
> 所以：apply 必须整体不可抛；能失败的功能要能被降级；失败原因要写进可读通道。

`test/registration.test.mjs` 用四个用例把这条钉死（locale 抛错 / slots.inject 抛错 /
注册被顶掉 / 连 effect、spec、register 全坏），任何回归都会当场失败。

## 6. 刻意不做的事

- **不注册新的会话 target / view definition**：座位 ledger 只认 `conversation.view`
  的条目，出厂 chat/trajectory 之所以还注册 target，是因为它们要投影自己的节点树；
  本视图直接消费事件窗口，不需要装配管线。
- **不加配置项**：`cordis.patch.yml` 里没有 `config` 块。
- **不做"在资源管理器中显示"**：那需要宿主 desktop 路由与授权坐标（出厂
  `ui-deliverables` 走 `present.open`），超出插件范围，也违背"不超出工作区"。
- **不落任何缓存文件**：视图每次挂载都从事件窗口重算，冷启动/热重载都不会读到旧状态。
