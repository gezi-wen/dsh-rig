/**
 * dsh-rig · 运行时表（纯逻辑层）
 *
 * 每个实验室的**瞬时**状态：状态机、日志环形缓冲、事件扇出。
 * 这些数据都不落盘（端口/token/pid 每次启动都变），所以和 `registry.js` 的持久状态分开。
 *
 * 为什么单独成模块：看管者（supervisor）要的是「把实验室拉起来、看着、收干净」，
 * 而「谁在什么状态、日志留给谁、事件怎么扇出去」是另一件事 —— 它还**不需要 IO**，
 * 因此可以在这里被穷举断言。
 */
import { STATUS, canTransition, isLive } from './constants.js'
import { appendLine, createLogBuffer, sliceSince } from './log-buffer.js'

/**
 * @param {object} p
 * @param {number} p.logRingLines 每个实验室保留多少行日志
 * @param {(line: string) => void} [p.log] 宿主日志（状态机违规这类内部异常）
 * @param {(event: object) => void} [p.onEvent] 额外的扇出（HTTP 层不用它，工具层可能用）
 */
export function createRuntimeTable({ logRingLines, log, onEvent }) {
  const map = new Map()
  const subs = new Set()
  const warn = typeof log === 'function' ? log : () => {}
  const external = typeof onEvent === 'function' ? onEvent : () => {}

  function emit(event) {
    try {
      external(event)
    } catch {
      /* 外部订阅者出错不能拖垮运行时 */
    }
    for (const fn of subs) {
      try {
        fn(event)
      } catch {
        /* 同上 */
      }
    }
  }

  function of(id) {
    let rt = map.get(id)
    if (!rt) {
      rt = {
        status: STATUS.created,
        child: null,
        pid: null,
        port: null,
        url: null,
        token: null,
        startedAt: null,
        exit: null,
        buffer: createLogBuffer(logRingLines),
      }
      map.set(id, rt)
    }
    return rt
  }

  return {
    of,
    emit,
    /** 订阅事件；返回退订函数。 */
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    /** 追加一行日志（自动脱敏、自动截断），并发一条 log 事件。 */
    pushLog(id, stream, raw) {
      const entry = appendLine(of(id).buffer, stream, raw)
      if (entry) emit({ type: 'log', id, entry })
      return entry
    },
    /** 迁移状态。非法迁移**只记一笔不改**：被绕过的状态机必须看得见。 */
    setStatus(id, next, extra = {}) {
      const rt = of(id)
      const from = rt.status
      if (from === next) return
      if (!canTransition(from, next)) {
        warn(`[dsh-rig] 非法状态迁移 ${from} → ${next} (${id})`)
        return
      }
      rt.status = next
      Object.assign(rt, extra)
      emit({ type: 'status', id, status: next, at: new Date().toISOString() })
    },
    logs(id, since = 0) {
      const rt = map.get(id)
      if (!rt) return { entries: [], seq: 0 }
      return { entries: sliceSince(rt.buffer, since), seq: rt.buffer.seq }
    },
    get(id) {
      return map.get(id)
    },
    drop(id) {
      map.delete(id)
    },
    /** 还活着的实验室 id（收工时按这个清单停）。 */
    liveIds() {
      return [...map.entries()].filter(([, rt]) => isLive(rt.status)).map(([id]) => id)
    },
    dispose() {
      subs.clear()
    },
  }
}
