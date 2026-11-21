/**
 * dsh-rig · 版本切换（薄逻辑）
 *
 * 单独成文件的原因：它要「先确认那个版本真的装着，再改记录」，是**先后顺序**的约束，
 * 跟生命周期不是一类东西；留在看管者里会把那个本就顶到行数上限的文件继续撑大。
 */
import { resolveCoreBin } from './core-bin.js'

/**
 * 决定并写回 lab.version。装不上的版本在这里就抛，别把失败推给下一次启动。
 * @returns {Promise<string>} 生效的版本号（`host` 表示跟随宿主）
 */
export async function planVersionChange({ lab, version, root, env }) {
  const next = typeof version === 'string' && version.trim() !== '' ? version.trim() : 'host'
  if (next !== 'host') await resolveCoreBin({ version: next, root, env })
  lab.version = next
  return next
}
