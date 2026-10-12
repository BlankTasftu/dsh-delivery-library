/**
 * 测试脚手架：在 Node 里**真实执行** `lib/client.js`。
 *
 * 两件事：
 *   1. `loadClientBundle()` —— 复刻 DSH 浏览器侧的装载契约
 *      （`window.__ModuleLoader__.load({id, factory})` + `factory(require)`），
 *      所以测的是**要发货的那个文件本身**，不是它的副本。
 *   2. `createRuntime()` —— 一个够用就好的迷你 React 运行时：函数组件、hook 状态、
 *      在 setState 后整棵树重渲染。够用来断言"点一下页签，列表真的换了"。
 *
 * 这里刻意不引入任何第三方依赖：工作区没有 node_modules，也不该为了跑测试引进。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** 读 lib/client.js 源码（测试与发货是同一份文件）。 */
export function readClientSource() {
  return readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
}

/** 迷你 React：只实现本插件用到的那几个 API。 */
export function createReact() {
  let current = null // 当前渲染中的组件记录
  let schedule = null // 由运行时注入的重渲染回调

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const merged = { ...(props === null || props === undefined ? {} : props) }
      const flat = children.length > 0 ? children : merged.children
      if (flat !== undefined) merged.children = flat
      return { type, props: merged }
    },
    useState(initial) {
      const record = current
      const index = record.cursor++
      if (record.hooks.length <= index) {
        record.hooks[index] = typeof initial === 'function' ? initial() : initial
      }
      const setter = (next) => {
        const value = typeof next === 'function' ? next(record.hooks[index]) : next
        if (Object.is(value, record.hooks[index])) return
        record.hooks[index] = value
        if (schedule !== null) schedule()
      }
      return [record.hooks[index], setter]
    },
    useMemo(factory, deps) {
      const record = current
      const index = record.cursor++
      const previous = record.hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return previous.value
      const value = factory()
      record.hooks[index] = { deps, value }
      return value
    },
    useEffect(effect, deps) {
      const record = current
      const index = record.cursor++
      const previous = record.hooks[index]
      if (previous !== undefined && sameDeps(previous.deps, deps)) return
      record.hooks[index] = { deps, cleanup: effect() }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const record = current
      const index = record.cursor++
      if (record.hooks[index] === undefined) {
        record.hooks[index] = { unsubscribe: subscribe(() => schedule !== null && schedule()) }
      }
      return getSnapshot()
    },
    setScheduler(fn) {
      schedule = fn
    },
  }
  React.__setCurrent = (record) => {
    current = record
  }
  return React
}

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/**
 * 按 DSH 的装载契约执行客户端 bundle。
 * @returns `{ exports, errors }`；bundle 里的 `console.warn` 会被收集到 errors。
 */
export function loadClientBundle() {
  const loaded = []
  const window = {
    __ModuleLoader__: {
      load(entry) {
        loaded.push(entry)
      },
    },
  }
  const source = readClientSource()
  // 客户端 bundle 是脚本形态（没有 import/export），用 Function 求值即可。
  new Function('window', source)(window)
  if (loaded.length !== 1) throw new Error(`bundle 应注册 1 个模块，实际 ${loaded.length}`)
  const entry = loaded[0]
  const react = createReact()
  const required = []
  const exports = entry.factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return react
    throw new Error(`测试基座没有提供模块：${specifier}`)
  })
  return { entry, exports, react, required }
}

/**
 * 迷你渲染器：把元素树渲染成可断言的形态，并支持重渲染。
 *
 * @param element - 根元素。
 * @param react - createReact() 的返回值。
 * @returns `{ text, elements, find, click, type }`。
 */
export function createRuntime(element, react) {
  let root = element
  let tree = null
  let rendering = false
  const records = new Map()

  const render = () => {
    let dirty = true
    let guard = 0
    while (dirty && guard < 50) {
      guard += 1
      dirty = false
      react.setScheduler(() => {
        dirty = true
      })
      tree = walk(root, '0', records, react)
    }
    react.setScheduler(null)
    return tree
  }

  const api = {
    render,
    get tree() {
      return tree
    },
    /** 全部文本。 */
    text() {
      return collectText(tree).join('')
    },
    /** 扁平化后的宿主元素（type 为字符串）。 */
    elements() {
      const list = []
      flatten(tree, list)
      return list
    },
    /**
     * 找第一个匹配的宿主元素。
     * @param predicate - 匹配函数 `(element) => boolean`。
     */
    find(predicate) {
      return api.elements().find(predicate)
    },
    /**
     * 点击第一个匹配的元素（触发 onClick）。
     * @param predicate - 匹配函数。
     */
    click(predicate) {
      const target = api.find(predicate)
      if (target === undefined) throw new Error('找不到可点击的元素')
      if (typeof target.props.onClick !== 'function') throw new Error('元素没有 onClick')
      target.props.onClick({ stopPropagation() {}, preventDefault() {} })
      render()
    },
    /** 触发一个 input 的 onChange。 */
    type(predicate, value) {
      const target = api.find(predicate)
      if (target === undefined) throw new Error('找不到输入框')
      target.props.onChange({ target: { value } })
      render()
    },
  }
  render()
  if (rendering) throw new Error('渲染状态异常')
  return api
}

function walk(node, path, records, react) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child, index) => walk(child, `${path}.${index}`, records, react))
  if (typeof node.type === 'function') {
    let record = records.get(path)
    if (record === undefined) {
      record = { hooks: [], cursor: 0 }
      records.set(path, record)
    }
    record.cursor = 0
    react.__setCurrent(record)
    const rendered = node.type({ ...node.props, children: undefined })
    return walk(rendered, `${path}:out`, records, react)
  }
  const children = node.props === undefined ? undefined : node.props.children
  return {
    type: node.type,
    props: node.props,
    children: children === undefined ? [] : normalize(walk(children, `${path}.c`, records, react)),
  }
}

function normalize(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return []
  return Array.isArray(value) ? value : [value]
}

function collectText(node) {
  if (node === null || node === undefined) return []
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(collectText)
  return collectText(node.children)
}

function flatten(node, list) {
  if (node === null || node === undefined || typeof node === 'string') return
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, list)
    return
  }
  if (typeof node.type === 'string') list.push(node)
  flatten(node.children, list)
}
