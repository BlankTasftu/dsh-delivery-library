# 变更记录

本插件没有构建步骤：`lib/` 下就是发货文件本身，改完刷新页面即生效。

## 0.2.0 — 2026-10-12

**修复一个会导致 DSH 桌面端退出的缺陷（0.1.0 引入）。**

- 修复：样式幂等判断拼出了非法选择器
  `style[data-plugin-css=""…""]`（手写引号 + `JSON.stringify` 自带引号 = 双层），
  `document.querySelector` 抛 `SyntaxError` → `apply` 抛错 → 客户端启动审计判定该条目
  `failed` → 桌面主进程收到 `web boot: N entry did not activate` 后**退出进程**。
  现在引号只来自 `JSON.stringify` 一处。
- 新增：`apply` 结构化到"绝不抛错" —— 每一步单独兜住，任何一步失败只降级、不冒泡。
  **客户端插件 apply 里任何未捕获异常都会让用户的桌面端退出一次**，这条契约写进了
  注释、README 与测试。
- 新增：失败时把面包屑（哪一步失败、异常文本、槽位是否已声明）写进 `shell.overlay`
  里一个渲染为 null 的条目 id —— 这是唯一一个插件作者能只读看到的客户端表面。
  首次事故就是靠它一次命中的。
- 新增：`test/styles.test.mjs`（带选择器校验的 document 桩，非法选择器必须像真浏览器
  一样抛错）、`test/registration.test.mjs` 的 4 条崩溃防护用例。
- 硬化：事件窗口快照增加**身份判等**。此前只比对 `revision`，若某个来源不带 revision，
  `getSnapshot()` 会每次返回新对象，把 React 的 `useSyncExternalStore` 拖进渲染循环。
- 硬化：等待会话绑定的重试定时器加上限（500ms × 240，2 分钟封顶），不再可能留下
  一个永远跑的定时器。
- 修复（UX）：复制反馈"已复制"现在 2 秒后自动复位，不会一直挂着。

## 0.1.0 — 2026-10-12

- 首个版本：在对话窗的「对话 / 轨迹」之外追加第三个视图 `delivery-library`（order 20）。
- 数据来源：当前会话已载入的事件窗口
  （`deliverables/presented` → 交付；`tool/call` + `tool/result` → 产出），
  不读磁盘、不访问网络、不新增宿主路由。
- 页面能力：两栏清单、搜索、点行在右侧栏预览、复制路径、重复交付计数、
  会话还有更早历史时的「加载更早」。
