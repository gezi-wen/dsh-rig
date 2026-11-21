/**
 * dsh-rig · 占用规则单测
 *
 * 这三条规则看着简单，但错了就是「两个会话同时驱动一个实验室」这种现场：
 * 没有主可以拿、自己是主幂等、别人是主只能 force。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { canDrive, claimOwner, releaseOwner } from '../lib/lab/ownership.js'

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
