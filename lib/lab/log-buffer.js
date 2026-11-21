/**
 * dsh-rig · 日志环形缓冲（纯逻辑层）
 *
 * 只回答一个问题：**给定上限，新来一行之后应该留下哪些行、序号是多少**。
 * 不持有订阅者、不认识 supervisor、不知道面板 —— 那些是上面两层的事。
 *
 * 为什么要单独抽：日志是唯一会被「复制出去给人看」的东西（面板复制按钮、工具回执），
 * 它的截断与序号规则值得单独断言，而不是埋在 500 行的进程看管里。
 */
import { redactLine } from './redact.js'

/**
 * 建一个缓冲。返回的对象是**可变**的（它就是那份状态），但所有变更都只经由两个方法。
 *
 * @param {number} cap 最多保留多少行
 */
export function createLogBuffer(cap) {
  if (!Number.isInteger(cap) || cap < 1) throw new Error('createLogBuffer: cap 必须是正整数')
  return {
    entries: [],
    seq: 0,
    cap,
  }
}

/**
 * 追加一行。
 * @returns {{seq: number, at: string, stream: string, text: string} | null} 空行返回 null（不占序号）
 */
export function appendLine(buffer, stream, rawLine, now = new Date()) {
  const text = redactLine(rawLine).replace(/\s+$/u, '')
  if (text === '') return null
  buffer.seq += 1
  const entry = { seq: buffer.seq, at: now.toISOString(), stream, text }
  buffer.entries.push(entry)
  if (buffer.entries.length > buffer.cap) buffer.entries.splice(0, buffer.entries.length - buffer.cap)
  return entry
}

/** 取序号大于 since 的那些行。 */
export function sliceSince(buffer, since = 0) {
  const floor = Number(since) || 0
  return buffer.entries.filter((entry) => entry.seq > floor)
}

/** 取最后 n 行。 */
export function tail(buffer, n) {
  const count = Math.max(1, Number(n) || 1)
  return buffer.entries.slice(-count)
}
