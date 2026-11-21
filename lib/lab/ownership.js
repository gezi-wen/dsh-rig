/**
 * dsh-rig · 实验室占用（纯逻辑）
 *
 * 实验室是**全局资源**，而面板是**会话级**的（右栏每个会话一份）。所以同一个实验室可能同时被
 * 两个会话看着：两套锁定开关、两路 agent 都能点它 —— 这就是需要「占用者」的原因。
 *
 * 规则只三条：
 *   1. 没有主 → 谁先 claim 谁是主；
 *   2. 自己是主 → 幂等成功；
 *   3. 别人是主 → 拒绝，除非显式 force（接手）。
 * 这个模块只算，不落盘；写回由调用方负责。
 */

/**
 * @param {object} lab 实验室记录（会被就地修改）
 * @param {string} sessionId 申请者的会话 id
 * @param {{force?: boolean, now?: Date}} options
 * @returns {{ok: boolean, changed: boolean, owner: string|null, reason?: string}}
 */
export function claimOwner(lab, sessionId, options = {}) {
  const force = Boolean(options.force)
  const now = options.now instanceof Date ? options.now : new Date()
  const applicant = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (applicant === '') return { ok: false, changed: false, owner: lab.ownerSessionId || null, reason: '缺少 sessionId' }

  const current = lab.ownerSessionId || null
  if (current === applicant) return { ok: true, changed: false, owner: current }
  if (current !== null && !force) {
    return { ok: false, changed: false, owner: current, reason: `已被会话 ${current} 占用` }
  }
  lab.ownerSessionId = applicant
  lab.ownerSince = now.toISOString()
  return { ok: true, changed: true, owner: applicant }
}

/** 释放占用（只清记录，不动实验室）。 */
export function releaseOwner(lab) {
  if (!lab.ownerSessionId) return false
  lab.ownerSessionId = null
  lab.ownerSince = null
  return true
}

/**
 * 这个会话能不能驱动实验室。
 * 没有主算能（避免「忘了 claim 就什么都不能点」），有主则只认主人。
 */
export function canDrive(lab, sessionId) {
  if (!lab.ownerSessionId) return true
  return lab.ownerSessionId === sessionId
}
