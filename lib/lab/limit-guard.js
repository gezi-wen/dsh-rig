/**
 * dsh-rig · 限额巡检（IO 层）
 *
 * 定时问一次「实验室现在吃多少内存」，超了就让看管者停掉它。
 *
 * 为什么这件事必须有：隔离做到了进程、`DSH_HOME`、端口、工作区，但**没做到内存** ——
 * 实验室是同一个人的进程，它把内存吃满时宿主会跟着卡死。那是唯一一条「实验室能弄死宿主」的路。
 *
 * 为什么放在单独文件：supervisor 已经贴着行数上限，而巡检是个可以整个删掉不影响生命周期的附加件。
 * 它只认 `targets()` 给的快照与两个回调，不认识实验室内部。
 */
import { DEFAULTS } from './constants.js'
import { rssMb } from './limits.js'

/**
 * @param {object} p
 * @param {() => Array<{id: string, pid: number|null, memoryLimitMb: number|null}>} p.targets 此刻在跑的实验室
 * @param {(id: string, mb: number) => void} p.onSample 采样成功（给面板显示当前占用）
 * @param {(lab: object, mb: number, limitMb: number) => Promise<void>} p.onExceed 超限
 * @param {(line: string) => void} p.log
 * @param {number} [p.intervalMs]
 */
export function startLimitGuard({ targets, onSample, onExceed, log, intervalMs = DEFAULTS.limitCheckMs }) {
  let timer = null
  let running = false

  async function tick() {
    // 上一轮还没跑完就跳过：`tasklist` 在慢机器上可能超过一个间隔。
    if (running) return
    running = true
    try {
      for (const lab of targets()) {
        if (!lab || !lab.pid) continue
        const mb = await rssMb(lab.pid)
        if (mb === null) continue
        onSample(lab.id, mb)
        const limit = lab.memoryLimitMb || DEFAULTS.memoryLimitDefaultMb
        if (mb > limit) await onExceed(lab, mb, limit)
      }
    } catch (err) {
      log(`[dsh-rig] 限额巡检失败：${err?.message ?? err}`)
    } finally {
      running = false
    }
  }

  timer = setInterval(() => {
    void tick()
  }, intervalMs)
  // 宿主退出时别让这个定时器拖住进程。
  if (timer && typeof timer.unref === 'function') timer.unref()

  return {
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
