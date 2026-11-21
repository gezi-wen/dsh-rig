/**
 * dsh-rig · 体检报告的解析单测
 *
 * 被测的是两个「把不可靠输入变成结构化事实」的函数：
 *   - 组合补丁是文本，靠正则抠 `- id / name`；
 *   - 启动日志是一锅粥，靠正则抠「被禁用 / 加载失败」。
 * 这两个函数错了，报告会**看起来正常但内容错**，比报错更难发现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseLogFacts, parsePatchRows, renderReport } from '../lib/lab/report.js'

test('补丁解析：抠出 id 与 name，忽略注释与缩进差异', () => {
  const text = [
    '# 组合补丁',
    '- insert:',
    '    - id: sage-mem',
    "      name: 'sage-mem'",
    '      config:',
    '        enabled: true',
    '    - id: dsh-rig',
    '      name: dsh-rig  # 行内注释',
  ].join('\n')
  const rows = parsePatchRows(text)
  assert.deepEqual(rows, [
    { id: 'sage-mem', name: 'sage-mem' },
    { id: 'dsh-rig', name: 'dsh-rig' },
  ])
})

test('补丁解析：坏输入不抛，给空数组', () => {
  assert.deepEqual(parsePatchRows(''), [])
  assert.deepEqual(parsePatchRows(null), [])
  assert.deepEqual(parsePatchRows('随便一段没有 id 的文字'), [])
})

test('日志事实：认出被禁用的插件行，同 id 只留一条', () => {
  const entries = [
    { text: 'dsh: disabling profile plugin row "panel-mcp-numen": Plugin @deepseek-ai/dsh-mcp-client@0.2.2-rc.1 is incompatible' },
    { text: 'dsh: disabling profile plugin row "panel-mcp-numen": 重复的一条' },
    { text: 'dsh: disabling profile plugin row "subagent-codex": requirements {...}' },
    { text: '[info]: ready' },
  ]
  const facts = parseLogFacts(entries)
  assert.equal(facts.denied.length, 2, '同 id 应合并成一条')
  assert.deepEqual(facts.denied.map((d) => d.id), ['panel-mcp-numen', 'subagent-codex'])
  assert.match(facts.denied[0].reason, /incompatible/u)
})

test('日志事实：认出加载失败，但不把普通日志当错误', () => {
  const entries = [
    { text: 'Error: Cannot find package "@x/y" imported from z' },
    { text: 'ERR_MODULE_NOT_FOUND' },
    { text: '[info]: ready' },
    { text: 'some normal line' },
  ]
  const facts = parseLogFacts(entries)
  assert.equal(facts.failures.length, 2)
  assert.equal(facts.denied.length, 0)
})

test('渲染：读不到的文件要显式说「读不到」，不能假装是空', () => {
  const text = renderReport({
    lab: { id: 'lab1', name: '甲', version: 'host', profile: 'rig-lab1' },
    runtime: { status: 'stopped', pid: null, port: null, startedAt: null, exit: null },
    declared: { bundles: [], dependencies: [], error: 'ENOENT' },
    patched: { rows: [], error: 'ENOENT' },
    logFacts: { denied: [], failures: [] },
    workspace: [],
  })
  assert.match(text, /读不到：ENOENT/u)
  assert.match(text, /stopped/u)
})
