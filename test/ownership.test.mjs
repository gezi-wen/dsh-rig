/**
 * dsh-rig · 占用规则单测
 *
 * 这三条规则看着简单，但错了就是「两个会话同时驱动一个实验室」这种现场：
 * 没有主可以拿、自己是主幂等、别人是主只能 force。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { canDrive, claimOwner, releaseOwner } from '../lib/lab/ownership.js'
import { DRIVE_ACTIONS, guardDrive, isDriveAction, shortSession, takenMessage } from '../lib/lab/drive-guard.js'
import { createTitleLookup } from '../lib/lab/session-title.js'

test('无主：先到先得', () => {
  const lab = {}
  const first = claimOwner(lab, 'session-a')
  assert.equal(first.ok, true)
  assert.equal(first.changed, true)
  assert.equal(lab.ownerSessionId, 'session-a')
  assert.ok(lab.ownerSince)
})

test('自己是主：幂等，不重复写时间', () => {
  const lab = { ownerSessionId: 'session-a', ownerSince: '2026-01-01T00:00:00.000Z' }
  const again = claimOwner(lab, 'session-a')
  assert.equal(again.ok, true)
  assert.equal(again.changed, false)
  assert.equal(lab.ownerSince, '2026-01-01T00:00:00.000Z')
})

test('别人是主：拒绝，并报出占用者', () => {
  const lab = { ownerSessionId: 'session-a' }
  const denied = claimOwner(lab, 'session-b')
  assert.equal(denied.ok, false)
  assert.equal(denied.owner, 'session-a')
  assert.match(denied.reason, /session-a/u)
  assert.equal(lab.ownerSessionId, 'session-a', '被拒时不能改记录')
})

test('别人是主 + force：接手并换时间', () => {
  const lab = { ownerSessionId: 'session-a', ownerSince: '2026-01-01T00:00:00.000Z' }
  const taken = claimOwner(lab, 'session-b', { force: true, now: new Date('2026-11-21T10:00:00.000Z') })
  assert.equal(taken.ok, true)
  assert.equal(taken.changed, true)
  assert.equal(lab.ownerSessionId, 'session-b')
  assert.equal(lab.ownerSince, '2026-11-21T10:00:00.000Z')
})

test('空 sessionId：拒绝，不写脏数据', () => {
  const lab = {}
  const bad = claimOwner(lab, '   ')
  assert.equal(bad.ok, false)
  assert.equal(lab.ownerSessionId, undefined)
})

test('释放：只清记录；canDrive 无主时放行', () => {
  const lab = { ownerSessionId: 'session-a', ownerSince: '2026-01-01T00:00:00.000Z' }
  assert.equal(canDrive(lab, 'session-b'), false)
  assert.equal(releaseOwner(lab), true)
  assert.equal(lab.ownerSessionId, null)
  assert.equal(canDrive(lab, 'session-b'), true)
  assert.equal(releaseOwner(lab), false, '已经没主了，释放应如实返回 false')
})

// ── 驾驶校验：面板 / plugin_lab / lab_ui 三方共用这一份规则 ─────────────

test('驾驶：读动作不算驾驶，写动作才算（改动词只改一处）', () => {
  for (const read of ['list', 'status', 'logs', 'report', 'versions', 'orphans']) {
    assert.equal(isDriveAction(read), false, `${read} 是读动作，不该要求占用`)
  }
  for (const verb of ['start', 'stop', 'restart', 'destroy', 'set_version', 'reap', 'ui']) {
    assert.equal(isDriveAction(verb), true, `${verb} 会改状态，必须在 DRIVE_ACTIONS 里`)
  }
  assert.equal(DRIVE_ACTIONS.length, 7)
})

test('驾驶：无主时动手即 claim（打开面板不占坑，动手才占）', () => {
  const lab = {}
  const verdict = guardDrive(lab, 'session-a', { now: new Date('2026-11-21T10:00:00.000Z') })
  assert.equal(verdict.allow, true)
  assert.equal(verdict.claimed, true)
  assert.equal(lab.ownerSessionId, 'session-a')
})

test('驾驶：自己是主 → 放行且不重复写时间', () => {
  const lab = { ownerSessionId: 'session-a', ownerSince: '2026-01-01T00:00:00.000Z' }
  const verdict = guardDrive(lab, 'session-a', { now: new Date('2026-11-21T10:00:00.000Z') })
  assert.equal(verdict.allow, true)
  assert.equal(lab.ownerSince, '2026-01-01T00:00:00.000Z')
})

test('驾驶：别人是主 → 拒绝，理由里带占用者（否则用户不知道找谁）', () => {
  const owner = '4f1c2a9e-8b3d-4c11-9f0a-77e2b6d1c333'
  const lab = { ownerSessionId: owner, ownerSince: '2026-01-01T00:00:00.000Z' }
  const verdict = guardDrive(lab, 'session-b')
  assert.equal(verdict.allow, false)
  assert.equal(verdict.owner, owner)
  // 会话 id 是 uuid，前 8 位足够认人；标题可能私密，所以只给 id。
  assert.match(verdict.reason, /4f1c2a9e/u)
  assert.equal(lab.ownerSessionId, owner, '被拒时不能改记录')
})

test('驾驶：force 才接手；缺 sessionId 一律拒绝（不写脏数据）', () => {
  const lab = { ownerSessionId: 'session-a' }
  const taken = guardDrive(lab, 'session-b', { force: true })
  assert.equal(taken.allow, true)
  assert.equal(lab.ownerSessionId, 'session-b')

  const anonymous = {}
  const denied = guardDrive(anonymous, '  ')
  assert.equal(denied.allow, false)
  assert.equal(anonymous.ownerSessionId, undefined)
})

test('驾驶：会话只露前 8 位，短 id 与文案同源', () => {
  assert.equal(shortSession('4f1c2a9e-8b3d-4c11-9f0a-77e2b6d1c333'), '4f1c2a9e')
  // 真实 id 带 `session-` 前缀：前缀人人相同，取前 8 位等于什么也没说（2026-11-21 真机发现的）。
  assert.equal(shortSession('session-240add47-aab6-4e43'), '240add47')
  assert.equal(shortSession(''), '未知会话')
  assert.match(takenMessage('4f1c2a9e-8b3d'), /4f1c2a9e/u)
  assert.match(takenMessage('session-240add47-aab6'), /240add47/u)
  assert.doesNotMatch(takenMessage('session-240add47-aab6'), /会话 session-/u, '不能只显示前缀')
})

// ── 占用者显示成会话标题（与左侧栏同一份；标题会随对话实时变，所以每次现查） ──

test('标题优先：有标题就用标题，没有才退回短 id', () => {
  assert.match(takenMessage('session-240add47-aab6', 'DSH 插件实验室开发规划'), /DSH 插件实验室开发规划/u)
  assert.doesNotMatch(takenMessage('session-240add47-aab6', 'DSH 插件实验室开发规划'), /240add47/u)
  assert.match(takenMessage('session-240add47-aab6', '  '), /240add47/u, '空白标题当没有')
})

test('标题查询：服务缺失 / 会话不在 / 抛错 一律给空串，绝不让 /state 挂掉', () => {
  assert.equal(createTitleLookup({ get: () => null })('abc'), '', '没有 sessions 服务')
  assert.equal(createTitleLookup({})('abc'), '', 'ctx 连 get 都没有')

  const session = { id: 'abc' }
  const withTitle = (title) => ({
    get: (key) =>
      key === 'sessions' ? { get: (id) => (id === 'abc' ? session : undefined) } : key === 'sessionTitle' ? { get: () => ({ title }) } : null,
  })
  assert.equal(createTitleLookup(withTitle('  DSH 插件实验室开发规划  '))('abc'), 'DSH 插件实验室开发规划', '要 trim')
  assert.equal(createTitleLookup(withTitle(undefined))('abc'), '')
  assert.equal(createTitleLookup(withTitle('x'))('nope'), '', '会话不在本宿主')

  const throwing = {
    get: () => {
      throw new Error('service disposed')
    },
  }
  assert.equal(createTitleLookup(throwing)('abc'), '')
})

test('标题查询：没有 sessionTitle 服务时，自己从会话事件里折叠（web profile 就没装那个 bundle）', () => {
  const session = {
    id: 'abc',
    snapshotEvents: () => [
      { type: 'user/message' },
      { type: 'session/title', data: { title: '旧标题' } },
      { type: 'user/message' },
      { type: 'session/title', data: { title: '  新标题  ' } },
    ],
  }
  // 只有 sessions 服务，没有 sessionTitle —— 2026-11-21 在 web profile 上实测就是这个组合
  const ctxOnlySessions = { get: (key) => (key === 'sessions' ? { get: () => session } : null) }
  assert.equal(createTitleLookup(ctxOnlySessions)('abc'), '新标题', '取最后一条，并 trim')

  // 服务在且给得出 → 用服务（它是官方口径）
  const both = {
    get: (key) =>
      key === 'sessions' ? { get: () => session } : key === 'sessionTitle' ? { get: () => ({ title: '服务给的' }) } : null,
  }
  assert.equal(createTitleLookup(both)('abc'), '服务给的')

  // 事件里没有标题 → 空串，调用方退回短 id
  const noTitle = { get: (key) => (key === 'sessions' ? { get: () => ({ snapshotEvents: () => [{ type: 'user/message' }] }) } : null) }
  assert.equal(createTitleLookup(noTitle)('abc'), '')
})
