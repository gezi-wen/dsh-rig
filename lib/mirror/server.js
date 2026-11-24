/**
 * dsh-rig · 画面镜像（IO 层）
 *
 * 每个实验室一条 CDP 会话，帧推给所有订阅者（面板的 SSE），输入从订阅者回传到实验室。
 *
 * 三层分工：
 *   - `cdp.js` 只认 CDP 协议（连、发命令、收事件）；
 *   - 这里管**生命周期与分发**（谁在看、帧给谁、断了怎么办）；
 *   - 路由层只做「把 HTTP 请求翻译成这里的方法调用」，不认识 CDP。
 *
 * 为什么帧是「推」而不是「拉」：`Page.captureScreenshot` 在窗口被遮挡时会一直等，
 * 而 screencast 由渲染进程主动出帧。详见 cdp.js 里 `startScreencast` 的注释。
 *
 * 背压策略：每个订阅者只留**最新一帧**。慢的订阅者丢旧帧而不是排队 ——
 * 画面落后几帧无所谓，排队把内存吃光才是事故。
 */
import { openCdp } from './cdp.js'

/** 一个实验室的镜像状态。 */
class Mirror {
  constructor(id, log) {
    this.id = id
    this.log = log
    this.session = null
    this.subs = new Set()
    this.lastFrame = null
    this.frames = 0
    this.startedAt = Date.now()
    this.closing = false
  }
}

export class MirrorHub {
  #mirrors = new Map()
  #log

  constructor(options = {}) {
    this.#log = typeof options.log === 'function' ? options.log : () => {}
  }

  /** 这个实验室现在有没有画面可看。 */
  status(id) {
    const mirror = this.#mirrors.get(id)
    return {
      attached: Boolean(mirror && mirror.session && !mirror.session.closed),
      viewers: mirror ? mirror.subs.size : 0,
      frames: mirror ? mirror.frames : 0,
      since: mirror ? mirror.startedAt : null,
    }
  }

  /**
   * 连上实验室的 CDP 并开始出帧。重复调用是幂等的（已经连上就直接复用）。
   *
   * @param {string} id 实验室 id
   * @param {{port: number}} options CDP 端口（桌面壳的 `--remote-debugging-port`）
   */
  async attach(id, options) {
    const existing = this.#mirrors.get(id)
    if (existing?.session && !existing.session.closed) return this.status(id)
    if (existing?.session) existing.session.close()

    const mirror = existing || new Mirror(id, this.#log)
    mirror.closing = false
    mirror.startedAt = Date.now()
    mirror.frames = 0
    mirror.lastFrame = null
    this.#mirrors.set(id, mirror)

    this.#log(`[dsh-rig] 连接实验室 ${id} 的 CDP（端口 ${options.port}）`)
    const session = await openCdp({ port: options.port, log: this.#log })
    mirror.session = session

    await session.startScreencast({
      quality: 60,
      maxWidth: 1280,
      maxHeight: 800,
      onFrame: (frame) => {
        mirror.frames += 1
        mirror.lastFrame = frame
        for (const sub of mirror.subs) {
          try {
            sub(frame)
          } catch (err) {
            this.#log(`[dsh-rig] 一个订阅者吞帧失败，已移除：${err?.message ?? err}`)
            mirror.subs.delete(sub)
          }
        }
      },
    })
    this.#log(`[dsh-rig] 实验室 ${id} 开始出帧`)
    return this.status(id)
  }

  /** 订阅帧。返回取消订阅函数。没有订阅者时仍持续出帧（代价很小，且能立刻给新订阅者一帧）。 */
  subscribe(id, fn) {
    const mirror = this.#mirrors.get(id)
    if (!mirror) throw new Error(`实验室 ${id} 没有镜像会话：先 attach`)
    mirror.subs.add(fn)
    if (mirror.lastFrame) {
      try {
        fn(mirror.lastFrame)
      } catch {
        /* 第一个订阅者立刻失败就当它没订阅 */
        mirror.subs.delete(fn)
      }
    }
    return () => mirror.subs.delete(fn)
  }

  /** 把输入转给实验室。事件形状见 contract.js 的 `normalizeInput`。 */
  async input(id, event) {
    const mirror = this.#mirrors.get(id)
    if (!mirror?.session || mirror.session.closed) throw new Error(`实验室 ${id} 没有镜像会话`)
    const session = mirror.session
    switch (event.type) {
      case 'mouse':
        await session.pointer({ type: event.action, x: event.x, y: event.y, button: event.button, clickCount: event.clickCount })
        return true
      case 'wheel':
        await session.wheel({ x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY })
        return true
      case 'text':
        await session.text(event.text)
        return true
      case 'key':
        await session.key({ key: event.key, code: event.code, windowsVirtualKeyCode: event.windowsVirtualKeyCode, modifiers: event.modifiers })
        return true
      default:
        throw new Error(`未知输入类型 ${event.type}`)
    }
  }

  /** 当前视口（客户端按它把像素坐标换成 CSS 坐标）。 */
  async viewport(id) {
    const mirror = this.#mirrors.get(id)
    if (!mirror?.session) return null
    return mirror.session.viewport(true).catch(() => null)
  }

  /** 断开并停止出帧。 */
  detach(id) {
    const mirror = this.#mirrors.get(id)
    if (!mirror) return false
    mirror.closing = true
    mirror.subs.clear()
    try {
      mirror.session?.close()
    } catch {
      /* 已经断了 */
    }
    this.#mirrors.delete(id)
    this.#log(`[dsh-rig] 实验室 ${id} 的镜像已断开`)
    return true
  }

  /** 插件卸载：全部断开。 */
  disposeAll() {
    for (const id of [...this.#mirrors.keys()]) this.detach(id)
  }
}
