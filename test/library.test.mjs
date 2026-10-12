/**
 * 折叠逻辑测试：会话事件窗口 → 交付清单。
 *
 * 这一层是插件的**事实来源**，所以测得最细：畸形事件、失败结果、
 * 增量窗口的三种 kind、去重与排序、快照引用稳定性。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadClientBundle } from './harness.mjs'

const { exports } = loadClientBundle()
const {
  normalizeKey,
  basenameOf,
  dirnameOf,
  extensionOf,
  mutationPath,
  parseEntries,
  deriveLibrary,
  createLibraryStore,
} = exports.__internals

/** 造一个 deliverables/presented 事件条目（客户端 feed 的外层形态：{ event }）。 */
const presented = (seq, turn, files) => ({
  event: { type: 'deliverables/presented', seq, time: seq, data: { turn, callId: `call-${seq}`, files } },
})

/** 造一个 tool/call 事件条目。 */
const toolCall = (seq, callId, name, args) => ({
  event: { type: 'tool/call', seq, time: seq, data: { callId, name, arguments: JSON.stringify(args), turn: 1, step: 1 } },
})

/** 造一个 tool/result 事件条目。 */
const toolResult = (seq, callId, isError = false) => ({
  event: { type: 'tool/result', seq, time: seq, data: { message: { isError, source: { callId }, content: [] } } },
})

/**
 * 可控的事件窗口源。
 *
 * 严格照 dsh-api-session-controller 的 `MutableSessionEventSource` 契约建模：
 *   snapshot = { entries（**完整已载入窗口**，惰性）, hasMore, revision, change }
 *   change   = { kind: 'replace' | 'prepend' | 'append' | 'settle-assistant', entries? }
 * 两处最容易写错的地方正是测试要点：首帧必须按完整窗口重建；settle 帧没有
 * change.entries，绝不能被当成增量追加。
 */
function fakeSource() {
  const listeners = new Set()
  let full = []
  let snapshot = { entries: full, hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } }
  const publish = (change, hasMore) => {
    snapshot = { entries: full, hasMore, revision: snapshot.revision + 1, change }
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 全量帧。 */
    replace(entries, hasMore = false) {
      full = entries.slice()
      publish({ kind: 'replace', entries: full.slice() }, hasMore)
    },
    /** 尾部增量（真实实现里 hasMore 保持不变）。 */
    append(entries, hasMore = snapshot.hasMore) {
      full = full.concat(entries)
      publish({ kind: 'append', entries: entries.slice() }, hasMore)
    },
    /** 头部补页增量。 */
    prepend(entries, hasMore = false) {
      full = entries.concat(full)
      publish({ kind: 'prepend', entries: entries.slice() }, hasMore)
    },
    /** 一次 attempt 的瞬态行被持久结算替换 —— 这种帧没有 change.entries。 */
    settle(hasMore = snapshot.hasMore) {
      publish({ kind: 'settle-assistant', attemptId: 'attempt-1' }, hasMore)
    },
    get listenerCount() {
      return listeners.size
    },
  }
}

test('路径归一化只做形状归一，不折叠大小写', () => {
  assert.equal(normalizeKey('.\\docs\\a.md'), 'docs/a.md')
  assert.equal(normalizeKey('./docs/a.md'), 'docs/a.md')
  assert.equal(normalizeKey('docs/a.md/'), 'docs/a.md')
  assert.equal(normalizeKey('A.md'), 'A.md')
  assert.equal(normalizeKey('a.md'), 'a.md')
  assert.equal(normalizeKey(undefined), '')
  assert.equal(basenameOf('C:\\工作区\\报告 v2.pdf'), '报告 v2.pdf')
  assert.equal(dirnameOf('C:\\工作区\\报告 v2.pdf'), 'C:/工作区')
  assert.equal(dirnameOf('报告.pdf'), '')
  assert.equal(extensionOf('a/b/Report.PDF'), 'pdf')
  assert.equal(extensionOf('Makefile'), '')
})

test('产出路径只从成功的第一方改动调用里取', () => {
  assert.equal(mutationPath('write', JSON.stringify({ file_path: 'a.md', content: 'x' })), 'a.md')
  // write 缺 content：不算写出
  assert.equal(mutationPath('write', JSON.stringify({ file_path: 'a.md' })), null)
  assert.equal(
    mutationPath('edit', JSON.stringify({ file_path: 'a.md', old_string: 'a', new_string: 'b' })),
    'a.md',
  )
  // old_string === new_string：不算改动
  assert.equal(mutationPath('edit', JSON.stringify({ file_path: 'a.md', old_string: 'a', new_string: 'a' })), null)
  assert.equal(
    mutationPath('str_replace_editor', JSON.stringify({ command: 'create', path: 'b.txt', file_text: 'x' })),
    'b.txt',
  )
  assert.equal(mutationPath('str_replace_editor', JSON.stringify({ command: 'view', path: 'b.txt' })), null)
  // 读、删、畸形参数一律不贡献
  assert.equal(mutationPath('read', JSON.stringify({ file_path: 'a.md' })), null)
  assert.equal(mutationPath('write', '{不是 JSON'), null)
  assert.equal(mutationPath('write', JSON.stringify({ file_path: '   ', content: 'x' })), null)
})

test('parseEntries：交付声明逐条展开，产出调用与结果配对', () => {
  const pending = new Map()
  const records = parseEntries(
    [
      presented(3, 1, [{ path: 'out/a.md', description: '主报告' }, { path: 'out/b.png' }]),
      // 畸形声明：缺 turn / files 不是数组 / 路径为空 —— 全部忽略
      { event: { type: 'deliverables/presented', seq: 4, data: { callId: 'x', files: [] } } },
      { event: { type: 'deliverables/presented', seq: 5, data: { turn: 1, files: 'nope' } } },
      presented(6, 1, [{ path: '   ' }]),
      toolCall(7, 'c1', 'write', { file_path: 'out/c.txt', content: 'hi' }),
      toolResult(8, 'c1', false),
      toolCall(9, 'c2', 'edit', { file_path: 'out/d.txt', old_string: 'a', new_string: 'b' }),
      toolResult(10, 'c2', true), // 失败 → 不产出
      toolCall(11, 'c3', 'read', { file_path: 'out/read-me.txt' }),
      toolResult(12, 'c3', false), // 非改动工具 → 不产出
    ],
    pending,
  )
  assert.deepEqual(
    records.map((record) => [record.kind, record.path]),
    [
      ['delivered', 'out/a.md'],
      ['delivered', 'out/b.png'],
      ['produced', 'out/c.txt'],
    ],
  )
  assert.equal(records[0].description, '主报告')
  assert.equal(records[0].turn, 1)
  assert.equal(records[1].description, undefined)
  // 已消费的待配对项不在表里留下残渣
  assert.equal(pending.size, 0)
})

test('deriveLibrary：同路径合并为一行，说明取最近一次，轮次取首次', () => {
  const records = [
    { kind: 'delivered', path: './out/a.md', description: '第一版', turn: 1, seq: 2 },
    { kind: 'delivered', path: 'out/a.md', description: '最终版', turn: 3, seq: 9 },
    { kind: 'delivered', path: 'out\\b.md', description: '', turn: 2, seq: 5 },
    { kind: 'produced', path: 'out/a.md', turn: 1, seq: 3 },
  ]
  const library = deriveLibrary(records, true)
  assert.equal(library.delivered.length, 2)
  assert.equal(library.produced.length, 1)
  assert.equal(library.hasMore, true)
  const a = library.delivered.find((entry) => entry.key === 'out/a.md')
  assert.equal(a.count, 2)
  assert.equal(a.description, '最终版')
  assert.equal(a.turn, 1)
  assert.equal(a.path, 'out/a.md')
  // 排序按首次出现的 seq 升序
  assert.deepEqual(library.delivered.map((entry) => entry.key), ['out/a.md', 'out/b.md'])
  // 空说明不会把已有的说明抹掉
  assert.equal(library.delivered.find((entry) => entry.key === 'out/b.md').description, undefined)
})

test('store：全量帧 → 增量 append → 头部 prepend，快照引用稳定', () => {
  const source = fakeSource()
  const store = createLibraryStore(source)
  source.replace([presented(2, 1, [{ path: 'a.md', description: '一' }])], true)

  const first = store.getSnapshot()
  assert.deepEqual(first.delivered.map((entry) => entry.path), ['a.md'])
  assert.equal(first.hasMore, true)
  // 同一 revision 反复取：必须是同一个对象（useSyncExternalStore 靠它判等）
  assert.equal(store.getSnapshot(), first)

  source.append([presented(9, 2, [{ path: 'b.md' }])], false)
  const second = store.getSnapshot()
  assert.notEqual(second, first)
  assert.deepEqual(second.delivered.map((entry) => entry.path), ['a.md', 'b.md'])
  assert.equal(second.hasMore, false)

  source.prepend([presented(1, 1, [{ path: 'z.md' }])], true)
  const third = store.getSnapshot()
  assert.deepEqual(third.delivered.map((entry) => entry.path), ['z.md', 'a.md', 'b.md'])
})

test('store：replace 帧重建全量并清空跨帧的待配对表', () => {
  const source = fakeSource()
  const store = createLibraryStore(source)
  // 第一帧只有调用、没有结果
  source.replace([toolCall(2, 'c1', 'write', { file_path: 'x.md', content: 'x' })])
  assert.equal(store.getSnapshot().produced.length, 0)
  // 第二帧是全量重建（断档）：旧的待配对调用不得与新窗口里的结果串上
  source.replace([toolResult(5, 'c1', false)])
  assert.equal(store.getSnapshot().produced.length, 0)
  // 同一窗口内调用 + 结果照样能配对
  source.replace([toolCall(7, 'c2', 'write', { file_path: 'y.md', content: 'y' }), toolResult(8, 'c2', false)])
  assert.deepEqual(store.getSnapshot().produced.map((entry) => entry.path), ['y.md'])
})

test('store：跨增量窗口的调用与结果仍能配对（调用在前一帧、结果在后一帧）', () => {
  const source = fakeSource()
  const store = createLibraryStore(source)
  source.replace([])
  assert.equal(store.getSnapshot().produced.length, 0)
  source.append([toolCall(2, 'c9', 'edit', { file_path: 'late.md', old_string: 'a', new_string: 'b' })])
  assert.equal(store.getSnapshot().produced.length, 0)
  source.append([toolResult(3, 'c9', false)])
  assert.deepEqual(store.getSnapshot().produced.map((entry) => entry.path), ['late.md'])
})

test('store：首帧落在增量窗口上时，仍按完整窗口重建（不丢历史）', () => {
  // 视图挂载前 store 不读窗口；挂载那一刻窗口的 change 可能已经是 append，
  // 但 entries 永远是完整已载入窗口 —— 首帧必须按它重建。
  const source = fakeSource()
  const store = createLibraryStore(source)
  source.replace([presented(2, 1, [{ path: 'early.md' }])])
  source.append([presented(3, 1, [{ path: 'later.md' }])])
  assert.deepEqual(store.getSnapshot().delivered.map((entry) => entry.path), ['early.md', 'later.md'])
})

test('store：settle-assistant 帧没有增量条目，不得重复累计', () => {
  const source = fakeSource()
  const store = createLibraryStore(source)
  source.replace([presented(1, 1, [{ path: 'a.md' }])])
  assert.equal(store.getSnapshot().delivered.length, 1)
  // 瞬态行被持久结算替换：窗口内容不变，只是 revision 前进
  source.settle()
  const after = store.getSnapshot()
  assert.equal(after.delivered.length, 1)
  assert.equal(after.delivered[0].count, 1)
})

test('store：append 帧带来的配对只算一次（增量语义，不重复整窗）', () => {
  const source = fakeSource()
  const store = createLibraryStore(source)
  source.replace([presented(1, 1, [{ path: 'a.md' }])])
  assert.equal(store.getSnapshot().delivered[0].count, 1)
  source.append([presented(2, 1, [{ path: 'b.md' }])])
  const snapshot = store.getSnapshot()
  assert.deepEqual(snapshot.delivered.map((entry) => entry.path), ['a.md', 'b.md'])
  assert.equal(snapshot.delivered[0].count, 1)
})

test('store：来源不带 revision 时也保持快照引用稳定（防渲染循环）', () => {
  // 故意造一个"不符合真实契约"的来源：永远返回同一个窗口对象、且没有 revision。
  // 只靠 revision 判等的话，getSnapshot() 每次都会返回新对象 —— 而 React 的
  // useSyncExternalStore 遇到不稳定快照会一路重渲染下去。身份判等就是那道安全网。
  const frozen = {
    entries: [presented(1, 1, [{ path: 'a.md' }])],
    hasMore: false,
    change: { kind: 'replace' },
  }
  const store = createLibraryStore({ getSnapshot: () => frozen, subscribe: () => () => {} })
  const first = store.getSnapshot()
  assert.deepEqual(first.delivered.map((entry) => entry.path), ['a.md'])
  assert.equal(store.getSnapshot(), first)
  assert.equal(store.getSnapshot(), first)
})

test('store：订阅在推帧后被唤醒，退订后不再唤醒', () => {
  const source = fakeSource()
  const store = createLibraryStore(source)
  let hits = 0
  const dispose = store.subscribe(() => {
    hits += 1
  })
  source.replace([presented(1, 1, [{ path: 'a.md' }])])
  assert.equal(hits, 1)
  assert.equal(source.listenerCount, 1)
  dispose()
  assert.equal(source.listenerCount, 0)
  source.append([presented(2, 1, [{ path: 'b.md' }])])
  assert.equal(hits, 1)
})

test('store：没有事件源时可用性为 false，快照为空且订阅是空操作', () => {
  const store = createLibraryStore(undefined)
  assert.equal(store.available, false)
  const snapshot = store.getSnapshot()
  assert.deepEqual(snapshot.delivered, [])
  assert.equal(snapshot.available, false)
  const dispose = store.subscribe(() => {
    throw new Error('不该被唤醒')
  })
  dispose()
})

test('store：事件源晚于视图出现时自行接上（会话绑定竞态自愈）', () => {
  const source = fakeSource()
  let available = false
  const store = createLibraryStore(() => (available ? source : undefined))
  assert.equal(store.getSnapshot().available, false)
  assert.deepEqual(store.getSnapshot().delivered, [])

  source.replace([presented(2, 1, [{ path: 'a.md', description: '迟到但没丢' }])])
  available = true
  const snapshot = store.getSnapshot()
  assert.equal(snapshot.available, true)
  assert.deepEqual(snapshot.delivered.map((entry) => entry.path), ['a.md'])
  assert.equal(snapshot.delivered[0].description, '迟到但没丢')
  // 接上之后照常订阅增量
  const seen = []
  const dispose = store.subscribe(() => seen.push(store.getSnapshot().delivered.length))
  source.append([presented(3, 1, [{ path: 'b.md' }])])
  assert.deepEqual(seen, [2])
  dispose()
})
