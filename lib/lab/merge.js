/**
 * dsh-rig · `labs.json` 跨进程合并（纯逻辑）
 *
 * 为什么会需要它：桌面版和 web 版可能**同时**装着这个插件，两个宿主进程共用同一份
 * `labs.json`，但各自持有一份内存状态。谁后写谁赢 —— 2026-11-21 实测发生过一次：
 * 另一端的一次保存把这一端刚建的实验室记录整条抹掉了。
 *
 * 规则只有三条：
 *   1. 盘上有的、内存里没有的 → **留着**（那是别的宿主进程管的实验室，不该被我写没）；
 *   2. 两边都有的同一个 id → 用内存那份（我管的那条以我为准）；
 *   3. 内存里有、盘上没有的 → 追加（我新建的）。
 *
 * 不解决的部分（要更大改动）：两个进程同时 `create` 可能撞 id —— 那一步在写盘锁里做，
 * 见 `state-store.js`。这里只算「合并成什么样」，不碰文件。
 */
import { emptyState } from './registry.js'

/**
 * @param {object} disk 盘上的状态（`{schemaVersion, labs}`）
 * @param {object} ours 本进程的状态
 * @returns {object} 合并后的状态（新对象，不改入参）
 */
export function mergeStates(disk, ours) {
  const mine = new Map((ours?.labs || []).map((lab) => [lab.id, lab]))
  const seen = new Set()
  const labs = []
  for (const lab of disk?.labs || []) {
    seen.add(lab.id)
    labs.push(mine.get(lab.id) || lab)
  }
  for (const lab of ours?.labs || []) {
    if (!seen.has(lab.id)) labs.push(lab)
  }
  const base = disk && Number.isInteger(disk.schemaVersion) ? disk : emptyState()
  return { schemaVersion: base.schemaVersion, labs }
}

/**
 * 这条实验室是不是**别的宿主进程**管的（只能看、不能驱动）。
 * 老记录没有 `hostId`（0.1.4 之前写的）—— 当作「自己的」，否则升级完就把用户锁在门外了。
 * @param {object} lab 实验室记录
 * @param {string} hostId 本进程身份
 * @returns {boolean}
 */
export function isForeign(lab, hostId) {
  return Boolean(lab && lab.hostId && hostId && lab.hostId !== hostId)
}
