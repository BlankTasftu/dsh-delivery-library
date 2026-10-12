/**
 * dsh-delivery-library —— 宿主半侧（Node）。
 *
 * ─── 为什么这里几乎是空的 ──────────────────────────────────────────────────
 * 本插件的全部功能都在浏览器半侧（`lib/client.js`）：往 `conversation.view`
 * 座位注册第三个视图，并从**当前会话的事件窗口**折叠出交付清单。
 *
 * 宿主半侧存在只有一个理由：DSH 的客户端模块系统（`dsh-client-modules`）是从
 * **宿主 Loader 那一行的模块说明符**反查 package.json、看见 `dsh.client` 声明后
 * 才会去装载 `/plugins/<id>/…` 的浏览器 bundle（见其 resolveMeta/locatePkgJson）。
 * 也就是说：没有这一行宿主入口，浏览器半侧就没有被装载的入口。
 *
 * 这里刻意**不做任何事**：不注册工具、不注册路由、不开文件句柄、不读会话日志。
 * 交付清单的数据来源是会话自身的事件流，浏览器已经拿到的那一份，不需要宿主
 * 再读一次磁盘 —— 这是"只以插件形式运行、尽量不超出工作区"的直接体现。
 */

/** 稳定的 Loader 身份（与 cordis.patch.yml 的 `name` 一致）。 */
export const name = 'dsh-delivery-library'

/** 不依赖任何宿主服务。 */
export const inject = []

/**
 * 宿主半侧的挂载点：本插件在宿主侧没有行为。
 *
 * 保留这个空实现是**契约要求**（Loader 会调用它），也刻意保持为空，便于审计：
 * 读这里就能确认"这个插件在宿主上什么都没干"。浏览器半侧由
 * `package.json` 的 `dsh.client` 声明单独装载。
 */
export function apply() {}
