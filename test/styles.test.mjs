/**
 * 样式注入测试 —— 这个文件的存在本身就是一次线上事故的产物。
 *
 * 事故：`ensureStyles()` 里把 `JSON.stringify()` 的输出又套了一层引号，得到
 * `style[data-plugin-css=""dsh-delivery-library/styles""]` —— **非法选择器**，
 * `document.querySelector` 抛 SyntaxError → `apply` 抛错 → 客户端启动审计判定
 * 该条目 `failed` → 桌面端收到 `web boot: 1 entry did not activate` 后**退出进程**。
 *
 * 为什么原有测试没抓到：Node 里没有 `document`，`ensureStyles()` 在 `typeof document
 * === 'undefined'` 处直接早返回，那段代码一次都没被执行过。
 *
 * 所以这里造一个**带选择器校验**的 document 桩：非法选择器必须像真浏览器一样抛错。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientBundle } from './harness.mjs'

const { exports } = loadClientBundle()
const { apply } = exports

/** 只允许属性选择器的两种合法写法：带引号（内部不得再出现引号）或不带引号（标识符字符）。 */
function assertValidSelector(selector) {
  const match = /^style\[data-plugin-css=(.*)\]$/.exec(selector)
  assert.ok(match !== null, `选择器形状不对：${selector}`)
  const value = match[1]
  if (value.startsWith('"')) {
    assert.ok(/^"[^"]*"$/.test(value), `属性值引号不合法（""…"" 是非法选择器）：${selector}`)
    return
  }
  assert.ok(/^[A-Za-z0-9_\-/.]+$/.test(value), `未加引号的属性值含非法字符：${selector}`)
}

/** 记录型 document 桩：querySelector 会校验选择器并复用已插入的 style。 */
function fakeDocument() {
  const inserted = []
  const document = {
    head: {
      appendChild(element) {
        inserted.push(element)
      },
    },
    querySelector(selector) {
      assertValidSelector(selector)
      const attrs = /^style\[data-plugin-css="?([^"]*)"?\]$/.exec(selector)
      const wanted = attrs === null ? undefined : attrs[1]
      return inserted.find((element) => element.dataset.pluginCss === wanted) ?? null
    },
    createElement(tagName) {
      return { tagName, dataset: {}, textContent: '' }
    },
  }
  return { document, inserted }
}

/** 在桩环境里跑一次 apply。 */
function withDocument(run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const { document, inserted } = fakeDocument()
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true })
  try {
    return run(inserted)
  } finally {
    if (descriptor === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', descriptor)
  }
}

/** 与 registration.test.mjs 同款的记录型 ctx。 */
function fakeContext(overrides = {}) {
  const calls = { effects: [], locales: [], slotInjects: [], registrations: [] }
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
      bind: () => (key) => key,
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
    sessions: { binding: () => undefined },
    get: () => undefined,
    ...overrides,
  }
  return ctx
}

const diagnosticOf = (ctx) => {
  const entry = ctx.calls.registrations.find((item) =>
    String(item.options.id ?? '').startsWith('dsh-delivery-library DIAG'),
  )
  return entry === undefined ? undefined : entry.options.id
}

test('样式注入用的是合法选择器，并且真的插进了 head', () => {
  withDocument((inserted) => {
    const ctx = fakeContext()
    assert.doesNotThrow(() => apply(ctx))
    assert.equal(inserted.length, 1, '应恰好注入一份样式')
    const style = inserted[0]
    assert.equal(style.tagName, 'style')
    assert.equal(style.dataset.plugin, 'dsh-delivery-library')
    assert.equal(style.dataset.pluginCss, 'dsh-delivery-library/styles')
    assert.match(style.textContent, /\.dshdl-root\{/)
    assert.equal(diagnosticOf(ctx), undefined, '健康路径不该留下诊断条目')
  })
})

test('样式注入是幂等的：重复 apply 不重复插入', () => {
  withDocument((inserted) => {
    apply(fakeContext())
    apply(fakeContext())
    assert.equal(inserted.length, 1)
  })
})

test('querySelector 抛错（例如选择器非法）时：apply 不抛，且留下诊断', () => {
  withDocument(() => {
    const ctx = fakeContext()
    const original = globalThis.document.querySelector
    globalThis.document.querySelector = () => {
      // 复刻真浏览器的报错文本
      throw new Error(
        'Failed to execute \'querySelector\' on \'Document\': \'style[data-plugin-css=""x""]\' is not a valid selector.',
      )
    }
    try {
      assert.doesNotThrow(() => apply(ctx))
    } finally {
      globalThis.document.querySelector = original
    }
    const diagnostic = diagnosticOf(ctx)
    assert.ok(diagnostic !== undefined)
    assert.match(diagnostic, /styles=X\(/)
    // 样式失败不该拖累视图注册
    assert.equal(ctx.calls.registrations.some((item) => item.options.id === 'delivery-library'), true)
  })
})

test('选择器校验器本身能识破事故写法（防测试自身失效）', () => {
  assert.throws(() => assertValidSelector('style[data-plugin-css=""dsh-delivery-library/styles""]'))
  assert.doesNotThrow(() => assertValidSelector('style[data-plugin-css="dsh-delivery-library/styles"]'))
  assert.doesNotThrow(() => assertValidSelector('style[data-plugin-css=dsh-delivery-library]'))
})
