/**
 * dsh-rig · 启动就绪等待（IO 层）
 *
 * 从 `supervisor.start()` 里抽出来的：那段 while 循环占着看管者二十多行，
 * 而它其实只回答一个问题 —— 「HTTP 起来了吗」。抽走之后 supervisor 只留生命周期，
 * 也顺手把它压回 420 行以内（0.1.6 加 pid 与补种之后它已经贴到上限）。
 *
 * 判定口径刻意保守：**拿到任意 HTTP 状态码**就算就绪（见 probe.js）。
 * 因为这个探针要区分的是「进程活着但服务没起」和「服务起了」，不是「服务是否健康」——
 * 实验室里跑的是正在开发的插件，健康检查本身可能就是坏的。
 */
import { STATUS } from './constants.js'
import { probeOnce } from './probe.js'

/**
 * @param {object} p
 * @param {string} p.id 实验室 id
 * @param {object} p.rt 运行时快照（就地观察 status / url）
 * @param {number} p.deadline 到点放弃（毫秒时间戳）
 * @param {{healthPollMs: number, startTimeoutMs: number}} p.config
 * @param {(id: string, status: string, extra?: object) => void} p.setStatus
 * @param {(id: string, stream: string, line: string) => void} p.pushLog
 * @param {(id: string, opts?: object) => Promise<unknown>} p.stop
 * @param {() => boolean} p.isDisposed 插件已卸载就别再等了
 */
export async function waitHealthy({ id, rt, deadline, config, setStatus, pushLog, stop, isDisposed }) {
  let firstFailure = ''
  while (!isDisposed() && Date.now() < deadline) {
    if (rt.status !== STATUS.starting) return
    if (rt.url) {
      const probe = await probeOnce(rt.url)
      if (probe.ok) {
        setStatus(id, STATUS.running)
        pushLog(id, 'rig', `就绪：${rt.url.replace(/token=[^&]+/u, 'token=***')}`)
        return
      }
      if (firstFailure === '') {
        firstFailure = probe.reason || 'unknown'
        pushLog(id, 'rig', `探针未通过（${firstFailure}），继续等…`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, config.healthPollMs))
  }
  if (rt.status !== STATUS.starting) return
  pushLog(id, 'rig', `启动超时（${Math.round(config.startTimeoutMs / 1000)}s）${firstFailure ? `：${firstFailure}` : ''}`)
  await stop(id, { asCrash: true })
}
