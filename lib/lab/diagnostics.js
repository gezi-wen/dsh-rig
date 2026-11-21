/**
 * dsh-rig · 诊断快照（只读装配）
 *
 * 面板与工具都想知道「宿主 core 从哪儿来的、隔离判定过不过、上限是多少」。
 * 这些是**只读**信息，和生命周期没关系，单独放一处，别让看管者为了拼一个对象多背十几行。
 *
 * 不写盘、不 spawn：只调用两个只读能力（解析宿主 core、判定隔离）。
 */
import { assertIsolated } from './naming.js'
import { resolveHostCore } from './versions.js'

/**
 * @param {object} p
 * @param {string} p.labRoot
 * @param {string} p.hostHome
 * @param {string} p.hostProfile
 * @param {boolean} p.isElectron
 * @param {Record<string, string|undefined>} p.env
 * @param {{startTimeoutMs:number, logRingLines:number, maxLabs:number}} p.limits
 * @param {string|null} p.sampleLabHome 用来现场演示一次隔离判定（没有实验室就给「还行」）
 */
export function buildDiagnostics({ labRoot, hostHome, hostProfile, isElectron, env, limits, sampleLabHome }) {
  const core = resolveHostCore(env)
  return {
    labRoot,
    hostHome,
    hostProfile,
    coreBin: core.bin,
    coreSource: core.source,
    isElectron,
    isolation: sampleLabHome ? assertIsolated(sampleLabHome, hostHome) : { ok: true, reason: '还没有实验室' },
    limits,
  }
}
