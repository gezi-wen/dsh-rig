/**
 * dsh-rig · 驾驶校验（纯逻辑）
 *
 * 实验室是**全局资源**，面板是**会话级**的：同一时刻可能有两个会话都看着它。
 * 「谁能动」这条规则只写在这里，面板（HTTP）、`plugin_lab`、`lab_ui` 三方共用一份 ——
 * 三处各写一遍的话，迟早有一处忘了改（比如面板挡住了、工具却照样能把别人的实验室重启）。
 *
 * 规则：动手才 claim。没有主 → 本次调用者占住；自己是主 → 放行；别人是主 → 拒绝，除非接手（force）。
 * 读动作（list / status / logs / report / versions / orphans）不在此列：谁都能看。
 * 本模块只算，落盘由调用方走 `supervisor.mutate`。
 */
import { canDrive, claimOwner } from './ownership.js'

/** 会改变实验室状态的动作。新增动词时只改这一处。 */
export const DRIVE_ACTIONS = Object.freeze(['start', 'stop', 'restart', 'destroy', 'set_version', 'reap', 'ui'])

/** @returns 这个动作是否需要占用。 */
export function isDriveAction(action) {
  return DRIVE_ACTIONS.includes(String(action || ''))
}

/** 会话短 id：面板与工具都只显示前 8 位 —— 会话标题可能私密，只给 id。 */
export function shortSession(sessionId) {
  const s = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (s === '') return '未知会话'
  // 真实会话 id 形如 `session-240add47-…`：前缀人人相同，直接取前 8 位只会得到 `session-`。
  // （2026-11-21 在真机上被智能体吐槽「归 session- 使用」，才发现短 id 根本没起识别作用。）
  const bare = s.startsWith('session-') ? s.slice('session-'.length) : s
  return bare.slice(0, 8)
}

/** 被占用的拒绝文案：必须带上占用者，否则用户不知道去找谁。 */
export function takenMessage(ownerSessionId) {
  return `实验室正由会话 ${shortSession(ownerSessionId)} 驾驶；要在面板里点「接手」才能拿过来`
}

/**
 * 判定这次调用能不能驱动实验室，并顺手落占用（就地修改 lab）。
 * @param {object} lab 实验室记录
 * @param {string} sessionId 调用者会话 id（工具取 `exec.agent.session.id`，面板取槽位 props）
 * @param {{force?: boolean, now?: Date}} options
 * @returns {{allow: boolean, claimed: boolean, owner?: string|null, reason?: string}}
 */
export function guardDrive(lab, sessionId, options = {}) {
  const applicant = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (applicant === '') return { allow: false, claimed: false, reason: '缺少 sessionId：无法确认驾驶者是谁' }
  if (lab.ownerSessionId && canDrive(lab, applicant)) return { allow: true, claimed: false, owner: lab.ownerSessionId }
  if (lab.ownerSessionId && !options.force) {
    return { allow: false, claimed: false, owner: lab.ownerSessionId, reason: takenMessage(lab.ownerSessionId) }
  }
  const claim = claimOwner(lab, applicant, { force: Boolean(options.force), now: options.now })
  if (!claim.ok) return { allow: false, claimed: false, owner: claim.owner, reason: claim.reason }
  return { allow: true, claimed: claim.changed, owner: claim.owner }
}
