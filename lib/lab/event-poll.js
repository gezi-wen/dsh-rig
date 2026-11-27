/**
 * dsh-rig · 事件实时刷（IO 层）
 *
 * 面板不需要新 UI：宿主每 3 秒拉一次实验室的 `/bridge/events`，把**新**事件按日志行推进环形缓冲，
 * 于是实验室在干什么会直接出现在面板的日志区（与 stdout 同一块地方）。
 *
 * 三条约束：
 *   - 只拉**增量**（记住每个 lab 的 lastSeq），第一次对齐到当前 total-1，不刷历史。
 *   - 只拉我们的派活会话（`rig-bridge`），不猜用户在界面上开着哪个会话。
 *   - 失败静默重试（实验室重启、端口还在起），绝不因为拉不到事件而打日志噪声。
 */
import { fetchEvents } from './bridge.js'

/**
 * @param {object} p
 * @param {() => Array<{id: string, status: string, url?: string}>} p.labs
 * @param {(id: string, stream: string, line: string) => void} p.pushLog
 * @param {string} [p.sessionId]
 * @param {number} [p.intervalMs]
 */
export function startEventPoll({ labs, pushLog, sessionId = 'rig-bridge', intervalMs = 3000 }) {
  const lastSeq = new Map()
  let running = false

  async function tick() {
    if (running) return
    running = true
    try {
      for (const lab of labs()) {
        if (lab?.status !== 'running' || !lab.url) continue
        const result = await fetchEvents({ labUrl: lab.url, sessionId, limit: 20 })
        if (!result.ok) continue
        const total = Number(result.total ?? 0)
        if (!lastSeq.has(lab.id)) {
          // 第一次看到这个 lab：对齐到末尾，只跟之后的新事件。
          lastSeq.set(lab.id, Math.max(0, total - 1))
          continue
        }
        const seen = lastSeq.get(lab.id) ?? 0
        for (const event of result.events ?? []) {
          if (event.seq <= seen) continue
          const text = event.text ? ` · ${String(event.text).slice(0, 80)}` : ''
          pushLog(lab.id, 'rig', `[实验室] ${event.seq} ${event.type}${text}`)
          lastSeq.set(lab.id, event.seq)
        }
      }
    } catch {
      /* 实验室在重启/端口还没起：下一轮再来 */
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  if (timer && typeof timer.unref === 'function') timer.unref()

  return {
    tick,
    stop() {
      clearInterval(timer)
    },
  }
}
