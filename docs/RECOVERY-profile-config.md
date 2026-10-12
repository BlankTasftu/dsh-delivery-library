# 恢复：新会话报 `no API key for provider route "deepseek-official"`

> **状态：已于 2026-10-12 14:32 恢复**（`agent-default-model` 块写回 `cordis.patch.yml`，
> 并用 `tools/check-profile-patch.mjs` 校验通过：YAML 可解析、5 条条目、
> 默认模型 = `deepseek-account / deepseek-flash`、bundles 9 条完整）。
> 本文件保留为**故障档案**：这个降级不报错、只静默换路由，值得留一份排查手册。
>
> 自查命令（只读，随时可跑）：
>
> ```powershell
> $NODE = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
> & $NODE tools\check-profile-patch.mjs
> ```
>
> 它用 DSH 自带的 js-yaml（从 app.asar 取，不引依赖）真解析该文件 —— 因为**这份文件写坏
> 会让整个 profile 起不来**，不能靠眼看。

## 症状

打开新会话即失败：

```
本轮运行失败
llm-deepseek: no API key for provider route "deepseek-official";
store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),
or export DEEPSEEK_API_KEY in the launching environment
```

已存在的会话（包括当时正在对话的那个）不受影响 —— 因为它们的模型在会话创建时就定了。

## 根因

`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（即 `$DSH_PROFILE_DIR`）在
**2026-10-12 13:45:47** 被重写过，
**手写的 `agent-default-model` 块被丢掉了**。

为什么这会让新会话跑不起来：

- `@deepseek-ai/dsh-agent-default-model` 的配置 schema **要求 `provider` 与 `model` 必填**，
  且该入口 `acceptsMissing: false`（可由 cordis Inspect 的 Config provider 读到：
  `status: schema`、`required: ["provider","model"]`、`default: {}`）。
- 本机是**用 DeepSeek 账号登录**的，走的是 `deepseek-account` 这条路由。
- 配置一丢，默认模型就落回 **API Key 路由 `deepseek-official`** —— 而本机没有（也不需要）
  `DEEPSEEK_API_KEY`，于是报"no API key"。

> 顺带说明：在 13:42 启动的那个实例里，profile 还是旧的；13:45:47 的这次重写被**热应用**
> 到了运行中的实例，所以问题是"刚刚才出现"的。
> 触发者是一次"启用/停用 bundle"或设置页写入 —— 这类写入会**重写整份 patch 层**，
> 只保留它自己管理的条目。我在这前后也调过插件的启用/停用（`set_bundle`），
> 不排除是我那两次调用或你在插件页的操作触发的。

## 恢复片段（粘回 `cordis.patch.yml` 顶部）

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
```

`provider` / `model` 换成你在「设置 → 模型」里真正要用的那对也行；关键是**不能没有它**。

## 另一条路（不手改 YAML）

「设置 → 插件」，找到 **`@deepseek-ai/dsh-agent-default-model`** 这一条，在它的配置表单里
填 `provider: deepseek-account`、`model: deepseek-flash` 并保存 —— 走官方设置表单写入的是
**管理器自己管理的格式**，不容易被下一次重写丢掉。

改完若新会话仍报同样的错，重启一次桌面端（profile 在启动时组合）。

## 同时丢了什么（不影响使用）

同一次重写还丢掉了 `cordis.patch.yml` 里手写的 `dsh-ark` 配置块。
**这一块丢了没有影响**：`dsh-ark` 包自带 `cordis.patch.yml`（随 bundle 层生效），
里面是同一份 ark / speech / output 配置（已核对：baseUrl、credential 名、
imageModel `doubao-seedream-5-0-pro-260628`、videoModel `doubao-seedance-2-0-260128`、
`resourceTts: seed-tts-2.0` 等逐项一致）。

## 这次重写前后的对照

```yaml
# 重写前（12:56 读到的 cordis.patch.yml，56 行）
- id: agent-default-model        # ← 丢了
  ...
- id: ui-settings-account        # 保留
- id: ui-chat                    # 保留
- id: ui-settings                # 保留
- id: dsh-ark                    # 丢了（包自带同款，无影响）
```

```yaml
# 重写后（13:45:47 起，766 字节）
- id: ui-settings-account
- id: ui-chat
- id: ui-settings
- id: ui-conversation            # ← 新增：busyEnter: steer（你的设置，要保留）
```

恢复时**不要删掉 `ui-conversation: busyEnter: steer`** 那一条。

## 建议：给这份 patch 留个副本

这类"配置被重写"不会再报错，只会**静默降级**（默认模型换了、插件配置没了）。
建议在插件启用/停用、或在设置页改过东西之后，扫一眼 `cordis.patch.yml`：
关键条目（`agent-default-model` 的 provider/model）还在不在。
本文件顶部的片段可以直接用；想要更省事，把整份文件复制一份到工作区留档也行。
