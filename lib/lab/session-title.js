/**
 * dsh-rig · 会话标题查询（宿主侧适配）
 *
 * 面板要显示「谁在驾驶实验室」。只给 id 前 8 位等于没说 —— 真实 id 是
 * `session-240add47-…`，前 8 位人人相同（2026-11-21 真机上被智能体吐槽才发现）。
 * 所以改用**会话标题**，它跟左侧栏列表里显示的是同一份数据。
 *
 * 两条来源，按顺序试：
 *   1. `sessionTitle` 服务（官方 `dsh-session-title`，装了「随对话更新的标题」那个 bundle 才有）；
 *   2. 退一步**自己从会话事件里折叠**：最后一条 `session/title` 事件的 `data.title` 就是当前标题。
 *      —— 2026-11-21 实测：web profile 没装那个 bundle，服务不存在，但会话日志里**已经有标题事件**
 *      （是桌面版生成的），于是第一条路返回空、面板只能退回 id。折叠这条路不依赖任何可选 bundle。
 *
 * 标题会变（首条消息后自动生成、之后还可能重算或被改名钉住），所以**每次现查**，不缓存、不订阅：
 * 调用方（HTTP /state、工具拒绝文案）本来就每次请求都会来问一次。
 *
 * 三条边界：拿不到（会话不在本宿主 / 还没生成标题）→ 空串，调用方退回短 id；
 * 出错不抛（标题是装饰，不值得让 /state 挂掉）；标题可能含会话内容，展示方负责截断。
 */

/** 从会话事件里折叠出最新标题：不依赖 `sessionTitle` 服务与任何可选 bundle。 */
function foldTitle(session) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : null
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      return event.data.title.trim()
    }
  }
  return ''
}

/**
 * @param {object} ctx 宿主 ctx（只用到 `ctx.get`）
 * @returns {(sessionId: string) => string} 会话 id → 标题；查不到给空串
 */
export function createTitleLookup(ctx) {
  const service = (key) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(key) : null
    } catch {
      return null
    }
  }
  return (sessionId) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') return ''
    try {
      const sessions = service('sessions')
      if (!sessions || typeof sessions.get !== 'function') return ''
      const session = sessions.get(id)
      if (!session) return ''
      const titles = service('sessionTitle')
      if (titles && typeof titles.get === 'function') {
        const snapshot = titles.get(session)
        const viaService = snapshot && typeof snapshot.title === 'string' ? snapshot.title.trim() : ''
        if (viaService !== '') return viaService
      }
      return foldTitle(session)
    } catch {
      return ''
    }
  }
}
