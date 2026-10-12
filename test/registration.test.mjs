/**
 * 注册契约测试：`apply(ctx)` 到底往座位上放了什么。
 *
 * 这里的判据直接来自 cordis Inspect 读到的真实目录：
 *   conversation.view（list, scope=session）
 *     registration: { id 必填, order 数字, label: string | (() => string) }
 *     occupants:    chat(order 0) / trajectory(order 10)
 * 本插件必须是**新 id**（追加），不能复用出厂 id（那会替换掉对话或轨迹）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientBundle } from './harness.mjs'

const { exports } = loadClientBundle()
const { apply, inject, NS, VIEW_ID, VIEW_ORDER } = exports

/** 记录型假上下文：把 Cordis 的那几个 API 记下来。 */
function fakeContext(overrides = {}) {
  const calls = {
    effects: [],
    locales: [],
    slotInjects: [],
    registrations: [],
    labels: [],
  }
  const ctx = {
    calls,
    effect(factory, label) {
      const dispose = factory()
      calls.effects.push({ label, dispose })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    locale: {
      register(namespace, dicts) {
        calls.locales.push({ namespace, dicts })
        return () => {}
      },
      bind(namespace) {
        return (key, params) => {
          calls.labels.push({ namespace, key, params })
          return key
        }
      },
    },
    slots: {
      inject(key, callback) {
        calls.slotInjects.push(key)
        return callback()
      },
      register(options, component) {
        calls.registrations.push({ options, component })
        return () => {}
      },
    },
    sessions: {
      binding: () => undefined,
    },
    get: () => undefined,
    ...overrides,
  }
  return ctx
}

test('客户端半侧声明的最小服务依赖', () => {
  assert.deepEqual(inject, ['slots', 'locale', 'sessions'])
})

test('apply 只注册一个 conversation.view 座位，用的是新 id', () => {
  const ctx = fakeContext()
  apply(ctx)
  assert.equal(ctx.calls.slotInjects.length, 1)
  assert.equal(ctx.calls.slotInjects[0], 'conversation.view')
  assert.equal(ctx.calls.registrations.length, 1)
  const { options, component } = ctx.calls.registrations[0]
  assert.equal(options.name, 'conversation.view')
  assert.equal(options.id, VIEW_ID)
  assert.equal(VIEW_ID, 'delivery-library')
  // 出厂的两格不能被顶掉：id 必须与它们不同
  assert.notEqual(options.id, 'chat')
  assert.notEqual(options.id, 'trajectory')
  // 排在 chat(0) / trajectory(10) 之后
  assert.equal(options.order, VIEW_ORDER)
  assert.ok(options.order > 10)
  assert.equal(options.locale, NS)
  assert.equal(typeof component, 'function')
  assert.equal(typeof options.inject, 'function')
})

test('页签名走 thunk（切语言不用重新注册）', () => {
  const ctx = fakeContext()
  apply(ctx)
  const label = ctx.calls.registrations[0].options.label
  assert.equal(typeof label, 'function')
  assert.equal(label(), 'view.tab')
  // 每次投影都重新读词典
  assert.equal(label(), 'view.tab')
  assert.equal(ctx.calls.labels.length, 2)
})

test('词典以 NS 注册，且中英同键集', () => {
  const ctx = fakeContext()
  apply(ctx)
  assert.equal(ctx.calls.locales.length, 1)
  assert.equal(ctx.calls.locales[0].namespace, NS)
  const { zh, en } = ctx.calls.locales[0].dicts
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  assert.ok(Object.keys(zh).length > 10)
})

test('词典注册挂在 effect 上，视图注册由 slots.inject 自己持有控制器', () => {
  const ctx = fakeContext()
  apply(ctx)
  const labels = ctx.calls.effects.map((entry) => entry.label)
  assert.deepEqual(labels, ['dsh-delivery-library: 词典'])
  assert.equal(ctx.calls.slotInjects.length, 1)
  assert.equal(ctx.calls.slotInjects[0], 'conversation.view')
})

// ─────────────────────────────────────────────────────────────────────────────
// 崩溃防护：这段是**用一次真实事故换来的**契约，不是防御性编程洁癖。
//
// 客户端的启动审计（dsh-web-frontend）把任何未达 active 的条目当致命错误：
// 桌面端收到 "web boot: N entry did not activate" 后直接退出进程。也就是说
// apply 里抛出的任何异常 = 用户的 DSH 崩一次。所以下面这些用例逐条钉住
// "不论哪个环节坏掉，apply 都不能抛"，并把失败原因写进诊断通道。
// ─────────────────────────────────────────────────────────────────────────────

/** 找出诊断条目（注册进 shell.overlay / sidebar.panellist，渲染为 null）。 */
const diagnosticOf = (ctx) => {
  const entry = ctx.calls.registrations.find((item) => String(item.options.id ?? '').startsWith('dsh-delivery-library DIAG'))
  return entry === undefined ? undefined : entry.options.id
}

test('locale.register 抛错时：apply 不抛，且把失败原因写进诊断条目', () => {
  const ctx = fakeContext()
  ctx.locale.register = () => {
    throw new Error('locale register exploded')
  }
  assert.doesNotThrow(() => apply(ctx))
  const diagnostic = diagnosticOf(ctx)
  assert.ok(diagnostic !== undefined, '应留下诊断条目')
  assert.match(diagnostic, /locale=X\(locale register exploded\)/)
  assert.match(diagnostic, /spec=/)
})

test('slots.inject 抛错时：apply 不抛，视图失败但词典仍注册', () => {
  const ctx = fakeContext()
  ctx.slots.inject = () => {
    throw new Error('inject exploded')
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.match(diagnosticOf(ctx), /view=X\(inject exploded\)/)
  assert.equal(ctx.calls.locales.length, 1)
  assert.equal(ctx.calls.registrations.some((item) => item.options.id === 'delivery-library'), false)
})

test('注册被顶掉（重复 id）时：apply 不抛，并报告具体抛出条件', () => {
  const ctx = fakeContext()
  ctx.slots.register = (options, component) => {
    if (options.id === 'delivery-library') throw new Error('list slot "conversation.view" already has an entry with id "delivery-library"')
    ctx.calls.registrations.push({ options, component })
    return () => {}
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.match(diagnosticOf(ctx), /view=X\(list slot "conversation\.view" already has an entry/)
})

test('连 slots.spec / effect / 视图注册都坏掉时：apply 依然不抛（最坏只是没有页签）', () => {
  const ctx = fakeContext()
  ctx.effect = () => {
    throw new Error('effect exploded')
  }
  ctx.slots.spec = () => {
    throw new Error('spec exploded')
  }
  ctx.slots.inject = undefined
  ctx.slots.register = (options, component) => {
    if (options.name === 'conversation.view') throw new Error('register exploded')
    ctx.calls.registrations.push({ options, component })
    return () => {}
  }
  assert.doesNotThrow(() => apply(ctx))
  // 诊断通道（shell.overlay）仍然可用时，必须留下失败原因
  const diagnostic = diagnosticOf(ctx)
  assert.ok(diagnostic !== undefined)
  assert.match(diagnostic, /locale=X\(effect exploded\)/)
  assert.match(diagnostic, /view=X\(/)
})

test('槽位尚未声明时不做探测注册（探测只在已声明时有意义）', () => {
  const ctx = fakeContext()
  ctx.slots.spec = () => undefined
  apply(ctx)
  const probes = ctx.calls.registrations.filter((item) => String(item.options.id ?? '').startsWith('dl-probe-'))
  assert.deepEqual(probes, [])
  // 而且探测条目绝不能留在账本上（注册后立刻撤销）
  assert.equal(ctx.calls.registrations.some((item) => item.options.id === 'dl-probe-1'), false)
})

test('会话不可绑定时，inject 仍返回可渲染的 props（不抛错）', () => {
  const ctx = fakeContext()
  apply(ctx)
  const props = ctx.calls.registrations[0].options.inject('session-unknown')
  assert.equal(props.sessionId, 'session-unknown')
  assert.equal(props.library.available, false)
  assert.deepEqual(props.library.getSnapshot().delivered, [])
  assert.equal(props.openFile('a.md', undefined), false) // 没有右栏服务 → 退化
  return props.loadOlder().then(() => undefined)
})

test('inject 把右栏打开请求变成带会话坐标的资源地址', async () => {
  const opened = []
  const binding = {
    eventSource: { getSnapshot: () => ({ revision: 0, change: { kind: 'replace', entries: [] } }), subscribe: () => () => {} },
    session: { loadOlder: async () => {} },
  }
  const ctx = fakeContext({
    sessions: { binding: (id) => (id === 's1' ? binding : undefined) },
    get: (name) => (name === 'sidebarRight' ? { openResourceIn: (sessionId, address) => opened.push([sessionId, address]) } : undefined),
  })
  apply(ctx)
  const props = ctx.calls.registrations[0].options.inject('s1')
  assert.equal(props.library.available, true)
  assert.equal(props.openFile('out/报告.md', undefined), true)
  assert.equal(
    opened[0][1],
    'dsh-resource://file/session/s1/out/%E6%8A%A5%E5%91%8A.md',
  )
  // 工作区内的绝对路径折成工作目录相对形式
  assert.equal(props.openFile('D:/ws/out/a.md', 'D:\\ws'), true)
  assert.equal(opened[1][1], 'dsh-resource://file/session/s1/out/a.md')
  // 工作区之外的绝对路径保留绝对形式（去掉盘符里的编码）
  assert.equal(props.openFile('C:/elsewhere/a.md', 'D:\\ws'), true)
  assert.equal(opened[2][1], 'dsh-resource://file/session/s1/C:/elsewhere/a.md')
  await props.loadOlder()
})

test('右栏服务缺失时，退化到 openResource，再缺就返回 false', () => {
  const viaOpenResource = []
  const binding = { eventSource: undefined, session: undefined }
  const ctx = fakeContext({
    sessions: { binding: () => binding },
    get: (name) => (name === 'sidebarRight' ? { openResource: (address) => viaOpenResource.push(address) } : undefined),
  })
  apply(ctx)
  const props = ctx.calls.registrations[0].options.inject('s1')
  assert.equal(props.openFile('a.md', undefined), true)
  assert.equal(viaOpenResource.length, 1)

  const silent = fakeContext({ sessions: { binding: () => binding } })
  apply(silent)
  const silentProps = silent.calls.registrations[0].options.inject('s1')
  assert.equal(silentProps.openFile('a.md', undefined), false)
})

test('ctx.get 抛异常时不影响挂载（右栏服务按可选依赖处理）', () => {
  const ctx = fakeContext({
    sessions: { binding: () => ({ eventSource: undefined, session: undefined }) },
    get: () => {
      throw new Error('service unavailable')
    },
  })
  apply(ctx)
  const props = ctx.calls.registrations[0].options.inject('s1')
  assert.equal(props.openFile('a.md', undefined), false)
})
