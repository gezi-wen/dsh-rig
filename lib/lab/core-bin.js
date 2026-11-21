/**
 * dsh-rig · 选哪一份 DSH core（IO 层，只读）
 *
 * 两种来源：`host` = 用宿主自己那份；`<version>` = `<labRoot>/core/<version>/` 里装好的。
 * 单独成模块的理由：这段逻辑将来会被 M2 的「安装新版本」共用（装完要能立刻校验），
 * 而它跟进程看管没有关系。
 */
import { readFile } from 'node:fs/promises'
import { coreBinPath } from './layout.js'
import { resolveHostCore } from './versions.js'

/**
 * @returns {Promise<string>} core 的 lib/bin.js 绝对路径
 * @throws 版本没装 / 找不到宿主 core 时抛出，消息直接可读（会原样进面板日志）
 */
export async function resolveCoreBin({ version, root, env }) {
  if (version && version !== 'host') {
    const bin = coreBinPath(root, version)
    try {
      await readFile(bin, { encoding: 'utf8', flag: 'r' })
      return bin
    } catch {
      throw new Error(`版本 ${version} 未安装（安装动作在 M2）`)
    }
  }
  const core = resolveHostCore(env)
  if (!core.bin) throw new Error('找不到宿主 DSH core（DSH_INSTALL_DIR 未设置且解析失败）')
  return core.bin
}
