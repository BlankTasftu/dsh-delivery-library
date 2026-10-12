# dsh-delivery-library

在 DSH 对话窗的 **对话 / 轨迹** 两个页签之外，再加一个 **交付文件** 页签：把当前会话里
**全部显式交付**（`present`）和**全部文件产出**（`write` / `edit`）汇总成一份可检索的
文件库，一个会话一份，不用再往回翻聊天记录。

- **纯插件**：不改 DSH 本体，只往 `conversation.view` 座位追加一个新 id 的格子。
- **不读磁盘**：清单完全由当前会话**已载入的事件窗口**折叠而来，不新增宿主路由、
  不扫工作区、不碰会话日志文件。
- **两栏分开**：`交付` 只看模型显式声明的最终文件；`产出` 看 write / edit 真正写出的
  文件。两者不混。

## 它长什么样

对话窗顶部页签从 `对话 | 轨迹` 变成 `对话 | 轨迹 | 交付文件`。点进去：

```
┌ 交付文件库            本会话：交付 3 · 产出 12 ────────────┐
│ [ 交付 3 ] [ 产出 12 ]        [ 搜索文件名、路径或说明 ]   │
├───────────────────────────────────────────────────────────┤
│ ┌MD┐ 调研报告.md                    第 4 轮  ×2   [复制路径]│
│ │  │ 最终版，含结论与附录                                   │
│ │  │ out/reports                                           │
│ ┌PNG┐ chart.png                      第 4 轮              │
│ │   │ assets                                              │
├───────────────────────────────────────────────────────────┤
│ 交付 = present 声明 · 产出 = write / edit 成功写出         │
└───────────────────────────────────────────────────────────┘
```

- **点一行** → 在右侧栏预览该文件（走 `dsh-resource://file/session/<会话>/<路径>`）。
  没装右栏时自动退化成"复制路径"，点击不会变成没反应。
- **复制路径**按钮：悬停行时出现，不会连带打开预览。
- **搜索**：同时匹配文件名、目录、说明。
- **×N**：同一个文件被多次交付；说明取**最近一次**，轮次取**首次**进库那一轮。
- 会话很长、更早的历史还没载入时，底部出现 **加载更早**（走 `session.loadOlder()`）。

## 安装

本机已经装好了（desktop profile）。手工装/重装：

```powershell
# 用 DSH 插件管理器（推荐：它同时写 profile 依赖与 bundles 清单）
dsh plugin --profile desktop add link:D:\DeepSeekSpace\插件
```

等价的等价手工做法：在 `%DSH_HOME%\profiles\desktop\package.json` 里加

```jsonc
"dependencies": { "dsh-delivery-library": "link:D:/DeepSeekSpace/插件" },
"dsh": { "profile": { "bundles": [ /* … */, "dsh-delivery-library" ] } }
```

然后在该目录跑 `pnpm install`。

> **启用后一般无需刷新**：宿主会把新的启动图经 `/plugins/events`（SSE）推给已打开的
> 页面，页面随即物化并挂上这个条目（0.2.0 实测如此）。页签没出现时再按一次 F5。

⚠️ **给改这个插件的人（也包括未来的我）**：客户端插件的 `apply` 里**任何未捕获异常
都会让桌面端直接退出** —— 渲染进程的启动审计会把未达 `active` 的条目上报为
`web boot: N entry did not activate`，桌面主进程把它当致命错误。
所以本插件的 `apply` 被刻意写成**整体不可抛**（每步单独 try/catch），失败只降级、
并把面包屑写进 `shell.overlay` 的诊断条目。详见 [docs/DESIGN.md](docs/DESIGN.md#5-事故记录一次把桌面端打崩的-apply-抛错010--020)。

自查（本机只读探针，SSE 通道免鉴权）：

```powershell
$NODE = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $NODE tools\check-boot-graph.mjs      # 插件在不在启动图、在哪个批次、批次脚本能否取到
& $NODE tools\check-host-resolution.mjs # 从 profile 出发能否解析到 browser bundle
```

崩溃日志（如果哪天又崩了，先看这里）：

```
%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log
```

卸载：`dsh plugin --profile desktop remove dsh-delivery-library`，或从
`dsh.profile.bundles` 里删掉包名再 `pnpm install`；也可以在「设置 → 插件」里停用该 bundle。

## 数据口径（哪些文件会出现在这里）

| 栏位 | 来源 | 判据 |
| --- | --- | --- |
| 交付 | 会话事件 `deliverables/presented` | `present` 工具**成功**执行后由宿主 append，形如 `{ turn, callId, files: [{ path, description? }] }` |
| 产出 | 会话事件 `tool/call` + `tool/result` | 只认 `write`、`edit`、以及完整改写的 `str_replace_editor`；且**结果必须不是错误** |

也就是说：读文件、删除、失败或被中断的调用、参数残缺的调用，都不会进清单；
用终端命令（`pwsh`/`bash`）创建的文件也不会出现在「产出」里 —— 只有模型显式
`present` 才会进「交付」。这与出厂 `ui-deliverables` 的卡片口径一致。

同一路径按**归一化形状**（反斜杠、`./` 前缀、尾斜杠）合并为一行，**不折叠大小写**：
大小写敏感的文件系统上 `A.md` 与 `a.md` 是两个文件，猜错会把两份交付合成一行。

## 活动边界（这个插件只做插件该做的事）

这一条不是口头保证，而是 **`test/isolation.test.mjs` 里 10 个静态断言**钉住的：

| 面 | 结论 | 断言 |
| --- | --- | --- |
| 宿主半侧 | **什么都不做**：没有任何 `import`／`require`，不引用 `fs`/`child_process`/`net`/`http`/`process`/`eval`，`apply()` 是空函数 | 4 条 |
| 浏览器半侧 | 只 `require('react')`；不联网（无 fetch/XHR/WebSocket/EventSource）；不写任何存储（localStorage/sessionStorage/indexedDB/cookie）；无 `eval`；不碰文件（文件只拼一个 `dsh-resource://` 地址交给侧栏读） | 4 条 |
| 装载声明 | `cordis.patch.yml` **只插入自己这一行**，不含 `disabled`／`inject`／其它条目的覆盖；package.json 无安装脚本、无任何依赖、无可执行入口 | 2 条 |

运行时它到底动了什么：**注入一份带 `data-plugin` 标记的 `<style>`**（插件卸载时由宿主按标记回收）
＋ 在 `conversation.view` 座位注册一个格子 ＋ 注册两份词典。仅此而已。

> 安装动作本身（`dsh plugin add` / 插件管理器 / pnpm）会在 profile 目录里写
> `package.json` 的一条依赖与 bundles 名单，并建一个指向本目录的链接 —— 那是**安装器**
> 的写入，不是插件运行时行为；本插件在运行时对 profile、DSH 本体、系统都零写入。

## 已知边界

- 清单覆盖**已载入**的会话事件窗口。会话非常长时窗口可能只含尾部，底部会给
  「加载更早」；点它即向前补页，补进来的交付会立刻出现在清单里。
- 视图是**会话作用域**的：切换会话就换一份清单；空会话不渲染视图区（与出厂行为一致）。
- 交付卡片打开的是**当前文件**，不是交付那一刻的快照；文件被删掉后预览会报找不到。
- 不提供"在资源管理器中显示"：那需要宿主 desktop 路由与授权坐标，超出本插件范围。
- 路径原样使用会话记录里的拼写（含 `..`），与出厂 `ui-deliverables` 的资源地址判据完全一致
  —— 打开与否最终由宿主的会话文件服务裁决，插件不做也不该做路径改写。
- 极端长的会话（几百个产出文件）列表会一次性渲染，没有虚拟滚动；搜索框是主要的收敛手段。

## 开发

```
lib/index.js                    宿主半侧：空实现（只作为客户端 bundle 的装载入口）
lib/client.js                   浏览器半侧：视图 + 事件折叠（全部功能在这里）
test/                           60 个用例：折叠逻辑 / 注册契约 / 崩溃防护 / 样式选择器 /
                                渲染冒烟 / 隔离性 / 清单一致性
tools/asar-extract.mjs          只读：从 app.asar 抽取内置包源码（核对契约用）
tools/asar-ls.mjs               只读：列 asar 内某个目录
tools/check-boot-graph.mjs      只读：本插件在不在启动图、在哪个批次、批次可投递
tools/check-host-resolution.mjs 只读：从 profile 出发能否解析到 browser bundle
tools/check-profile-patch.mjs   只读：profile patch 的 YAML 是否完好、关键条目还在不在
tools/paths.mjs                 上面几个探针共享的路径解析（走环境变量，不写死机器路径）
docs/DESIGN.md                  为什么这样取数、座位契约、验证证据、事故记录
docs/RECOVERY-profile-config.md 故障档案：新会话报 no API key 的那次配置丢失
```

跑测试（不需要安装任何依赖）：

```powershell
$NODE = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $NODE --test "test/*.test.mjs"
```

`test/harness.mjs` 会按 DSH 的真实装载契约（`window.__ModuleLoader__.load` + `factory(require)`）
执行**要发货的那份 `lib/client.js`**，再用一个迷你 React 运行时把它渲染出来 ——
测的不是副本，也没有引入测试框架依赖。

## 版本

- `0.2.0` —— 修复 0.1.0 里一个会让 DSH 桌面端退出的选择器缺陷；`apply` 改为绝不抛错并带诊断通道；
  见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/DESIGN.md](docs/DESIGN.md) 第 5 节。

MIT · 见 [LICENSE](LICENSE)
