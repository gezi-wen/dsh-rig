/**
 * dsh-rig · 资源采样（IO 层）
 *
 * 只回答一个问题：这个进程现在占多少常驻内存（MB）。
 *
 * 为什么不引第三方包：`tasklist` / `ps` 各一行就够，而去掉一个依赖比多写十行划算 ——
 * 这个插件已经够重了，不该为一次采样再挂个 native addon。
 *
 * 采样失败一律返回 null：进程刚好退出、权限不够、命令行区域设置变了，都不该影响主流程。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * @param {number} pid
 * @returns {Promise<number|null>} 常驻内存（MB），取不到为 null
 */
export async function rssMb(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true,
        timeout: 8_000,
      })
      // "node.exe","1234","Console","1","123,456 K"
      // 内存列的分隔符随区域设置变（逗号 / 空格 / 点），所以整段数字一次抓完再清分隔符。
      const match = /"[^"]*","(\d+)","[^"]*","[^"]*","([\d\s.,]+)\s*K"/u.exec(stdout)
      if (!match) return null
      const kb = Number(match[2].replace(/[\s.,]/gu, ''))
      return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 8_000 })
    const kb = Number(String(stdout).trim())
    return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null
  } catch {
    return null
  }
}

