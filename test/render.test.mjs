/**
 * 渲染冒烟测试：把视图真的渲染出来，并模拟交互。
 *
 * 用 test/harness.mjs 的迷你运行时渲染**发货用的那个组件**，断言：
 * 两栏内容、搜索、空态、点击行触发打开、拿不到右栏时退化成复制、
 * hasMore 时出现「加载更早」、以及语言切换后文案真的变。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntime, loadClientBundle } from './harness.mjs'

const { exports, react } = loadClientBundle()
const { DeliveryLibraryView, createLibraryStore, dicts } = exports.__internals

/** 词典翻译器（真实词典 + {占位符} 替换）。 */
function translate(locale) {
  const dict = dicts[locale]
  return (key, params) => {
    const template = dict[key]
    if (template === undefined) throw new Error(`词典缺少键：${key}`)
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (_match, name) => String(params[name]))
  }
}

/** 造一个已经装满数据的 store。 */
function storeWith(entries, options = {}) {
  const window = {
    revision: 1,
    change: { kind: 'replace', entries },
    hasMore: options.hasMore === true,
  }
  const source = {
    getSnapshot: () => window,
    subscribe: () => () => {},
  }
  return createLibraryStore(source)
}

const presented = (seq, turn, files) => ({
  event: { type: 'deliverables/presented', seq, time: seq, data: { turn, callId: `c${seq}`, files } },
})
const toolCall = (seq, callId, path) => ({
  event: { type: 'tool/call', seq, data: { callId, name: 'write', arguments: JSON.stringify({ file_path: path, content: 'x' }), turn: 2 } },
})
const toolResult = (seq, callId) => ({
  event: { type: 'tool/result', seq, data: { message: { isError: false, source: { callId } } } },
})

/** 渲染一次视图。 */
function mount(props) {
  return createRuntime(react.createElement(DeliveryLibraryView, props), react)
}

const baseProps = (overrides = {}) => ({
  t: translate('zh'),
  library: storeWith([]),
  sessionId: 's1',
  openFile: () => true,
  loadOlder: () => Promise.resolve(),
  ...overrides,
})

const rowsOf = (runtime) => runtime.elements().filter((element) => element.props.className === 'dshdl-row')

test('默认页签渲染交付清单：文件名、说明、轮次、计数', () => {
  const library = storeWith([
    presented(2, 1, [{ path: 'out/交付说明.md', description: '最终交付' }]),
    presented(9, 3, [{ path: 'out/chart.png' }]),
  ])
  const runtime = mount(baseProps({ library }))
  const rows = rowsOf(runtime)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].props.title, 'out/交付说明.md')
  const text = runtime.text()
  assert.match(text, /交付文件库/)
  assert.match(text, /交付说明\.md/)
  assert.match(text, /最终交付/)
  assert.match(text, /chart\.png/)
  assert.match(text, /第 1 轮/)
  assert.match(text, /第 3 轮/)
  assert.match(text, /本会话：交付 2 · 产出 0/)
})

test('切到「产出」页签后列出 write/edit 写出的文件', () => {
  const library = storeWith([
    presented(2, 1, [{ path: 'out/交付.md' }]),
    toolCall(3, 'w1', 'src/index.mjs'),
    toolResult(4, 'w1'),
  ])
  const runtime = mount(baseProps({ library }))
  assert.equal(rowsOf(runtime).length, 1)
  runtime.click((element) => element.props.className === 'dshdl-segBtn' && element.props['data-active'] === 'false')
  const rows = rowsOf(runtime)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].props.title, 'src/index.mjs')
  assert.match(runtime.text(), /产出 1/)
})

test('搜索同时匹配文件名、目录与说明', () => {
  const library = storeWith([
    presented(1, 1, [{ path: 'docs/报告.md', description: '季度总结' }]),
    presented(2, 1, [{ path: 'assets/logo.svg' }]),
  ])
  const runtime = mount(baseProps({ library }))
  assert.equal(rowsOf(runtime).length, 2)
  const search = (element) => element.props.className === 'dshdl-search'
  runtime.type(search, '季度')
  assert.equal(rowsOf(runtime).length, 1)
  assert.equal(rowsOf(runtime)[0].props.title, 'docs/报告.md')
  runtime.type(search, 'assets')
  assert.equal(rowsOf(runtime).length, 1)
  assert.equal(rowsOf(runtime)[0].props.title, 'assets/logo.svg')
  runtime.type(search, '不存在的关键词')
  assert.equal(rowsOf(runtime).length, 0)
  assert.match(runtime.text(), /没有匹配的文件/)
})

test('空态：交付页与产出页各有自己的说明', () => {
  const runtime = mount(baseProps({ library: storeWith([]) }))
  assert.ok(runtime.find((element) => element.props.className === 'dshdl-empty') !== undefined)
  assert.equal(rowsOf(runtime).length, 0)
  const text = runtime.text()
  assert.match(text, /本会话还没有显式交付的文件/)
  assert.match(text, /交付来自 present 工具/)
  // 切到产出页：空态文案换成"产出"那一套
  runtime.click((element) => element.props.className === 'dshdl-segBtn' && element.props['data-active'] === 'false')
  assert.match(runtime.text(), /本会话还没有写出或改过的文件/)
  assert.match(runtime.text(), /write \/ edit/)
})

test('拿不到会话事件源时渲染可解释的空态，而不是崩溃', () => {
  const runtime = mount(baseProps({ library: createLibraryStore(undefined) }))
  assert.match(runtime.text(), /当前会话的事件流不可用/)
  assert.equal(rowsOf(runtime).length, 0)
})

test('点击行调用 openFile，并带上工作目录', () => {
  const opened = []
  const library = storeWith([presented(1, 1, [{ path: 'out/a.md' }])])
  const runtime = mount(
    baseProps({
      library,
      openFile: (path, cwd) => {
        opened.push([path, cwd])
        return true
      },
    }),
  )
  runtime.click((element) => element.props.className === 'dshdl-row')
  assert.deepEqual(opened, [['out/a.md', undefined]])
})

test('右栏不可用时点击退化为复制路径', () => {
  const copied = []
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        writeText: (text) => {
          copied.push(text)
          return Promise.resolve()
        },
      },
    },
    configurable: true,
  })
  try {
    const library = storeWith([presented(1, 1, [{ path: 'out/a.md' }])])
    const runtime = mount(baseProps({ library, openFile: () => false }))
    runtime.click((element) => element.props.className === 'dshdl-row')
    assert.deepEqual(copied, ['out/a.md'])
    assert.match(runtime.text(), /已复制/)
  } finally {
    if (descriptor === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', descriptor)
  }
})

test('复制按钮不冒泡到整行（不会顺手打开预览）', () => {
  const copied = []
  const opened = []
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        writeText: (text) => {
          copied.push(text)
          return Promise.resolve()
        },
      },
    },
    configurable: true,
  })
  try {
    const library = storeWith([presented(1, 1, [{ path: 'out/a.md' }])])
    const runtime = mount(
      baseProps({
        library,
        openFile: (path) => {
          opened.push(path)
          return true
        },
      }),
    )
    runtime.click((element) => element.props.className === 'dshdl-copy')
    assert.deepEqual(copied, ['out/a.md'])
    assert.deepEqual(opened, [])
  } finally {
    if (descriptor === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', descriptor)
  }
})

test('会话还有更早历史时给「加载更早」，点击触发补页', () => {
  let loads = 0
  const library = storeWith([presented(1, 1, [{ path: 'out/a.md' }])], { hasMore: true })
  const runtime = mount(
    baseProps({
      library,
      loadOlder: () => {
        loads += 1
        return Promise.resolve()
      },
    }),
  )
  const button = runtime.find((element) => element.props.className === 'dshdl-btn')
  assert.ok(button !== undefined)
  assert.match(runtime.text(), /加载更早/)
  runtime.click((element) => element.props.className === 'dshdl-btn')
  assert.equal(loads, 1)
})

test('英文词典下整页文案切换（页签名走 thunk）', () => {
  const runtime = mount(
    baseProps({
      t: translate('en'),
      library: storeWith([presented(1, 1, [{ path: 'out/report.md', description: 'final' }])]),
    }),
  )
  const text = runtime.text()
  assert.match(text, /Delivery library/)
  assert.match(text, /This session: 1 delivered · 0 produced/)
  assert.match(text, /Turn 1/)
  assert.match(text, /Delivered = present/)
  assert.doesNotMatch(text, /交付文件库/)
})

test('同一文件多次交付只占一行并带次数徽标', () => {
  const library = storeWith([
    presented(1, 1, [{ path: 'out/a.md', description: '一稿' }]),
    presented(5, 2, [{ path: './out/a.md', description: '终稿' }]),
  ])
  const runtime = mount(baseProps({ library }))
  const rows = rowsOf(runtime)
  assert.equal(rows.length, 1)
  assert.match(runtime.text(), /终稿/)
  assert.equal(runtime.text().includes('×2'), true)
})

test('没有说明时目录只显示一次（不与说明行重复）', () => {
  const runtime = mount(
    baseProps({ library: storeWith([presented(1, 1, [{ path: 'out/nested/only-path.md' }])]) }),
  )
  assert.equal(runtime.elements().filter((element) => element.props.className === 'dshdl-note').length, 1)
  assert.equal(runtime.elements().filter((element) => element.props.className === 'dshdl-path').length, 0)
  assert.match(runtime.text(), /out\/nested/)
  // 有说明时：说明一行 + 目录一行（各显示一次）
  const withDescription = mount(
    baseProps({
      library: storeWith([presented(1, 1, [{ path: 'out/nested/with-desc.md', description: '季度报告' }])]),
    }),
  )
  assert.equal(withDescription.elements().filter((element) => element.props.className === 'dshdl-note').length, 1)
  assert.equal(withDescription.elements().filter((element) => element.props.className === 'dshdl-path').length, 1)
})
