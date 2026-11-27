/**
 * dsh-rig · 孤儿回收（定时，IO 层）
 *
 * 为什么需要它：2026-11-27 实测栽过一次 —— 一个 19:55 留下的孤儿实验室进程占着 46000，
 * 新实验室看端口被占就换到 46001，而宿主面板上一切正常。**我一直在跟孤儿对话，
 * 排查了近一小时**（`wait` 代码明明已经部署，行为却是旧的）。
 *
 * 原来孤儿回收只有 `plugin_lab` 的手动动作（`orphans` / `reap`），没人会想起来点它。
 * 现在宿主自己每 10 分钟扫一次：只杀「命令行带 `--profile rig-<已知 lab>` 且当前不在管」的进程。
 */
import { reapOrphans } from './orphans.js'

/**
 * @param {object} p
 * @param {() => string[]} p.liveProfileNames 此刻在管的 profile 名（这些不算孤儿）
 * @param {(line: string) => void} p.log
 * @param {number} [p.intervalMs] 默认 10 分钟
 */
export function startReaper({ liveProfileNames, log, intervalMs = 600_000 }) {
  let timer = null
  let running = false

  async function sweep() {
    if (running) return null
    running = true
    try {
      const result = await reapOrphans({ trackedProfileNames: liveProfileNames(), dryRun: false })
      if (result.found.length > 0) {
        const failed = result.failed.length > 0 ? `，失败 ${result.failed.length}` : ''
        log(`[dsh-rig] 孤儿回收：发现 ${result.found.length} 个，清掉 ${result.killed.length}${failed}`)
      }
      return result
    } catch (err) {
      log(`[dsh-rig] 孤儿回收失败：${err?.message ?? err}`)
      return null
    } finally {
      running = false
    }
  }

  timer = setInterval(() => {
    void sweep()
  }, intervalMs)
  // 不要因为一个定时器拖着宿主进程退出。
  if (timer && typeof timer.unref === 'function') timer.unref()

  return {
    sweep,
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
