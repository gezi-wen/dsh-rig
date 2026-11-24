/**
 * dsh-rig-mirror · 宿主半（跑在**实验室**那个 DSH 实例里，往外推帧、接收输入）
 *
 * 方向固定为「插件当客户端」：实验室主动连宿主，理由是宿主不该反向连进实验室——
 * 实验室的端口每次重启都换，而宿主的地址由实验室启动参数给定，一次写好就稳定。
 *
 * ── 通道（二选一，已选 WebSocket）─────────────────────────────────────────────
 * 用 **Node 内建的全局 `WebSocket`**（undici，Node ≥ 22 自带；本机宿主运行时实测
 * `runtime/versions.json` = node 24.21.0，`typeof WebSocket === 'function'`）。零依赖：
 * 不 import `node:` 内建，也不 import `ws`。另外两条路不选：手写 `node:http` upgrade
 * 客户端要自己算 Sec-WebSocket-Key、逐帧掩码、拼帧头、处理分片与 ping/pong；HTTP POST
 * 分片推帧每帧一次请求 + chunked 头，输入还得另开长轮询，帧率 5/s 时开销比帧本身还大。
 *
 * ── 一条必须在 README 里写清的边界（骨架期实测）────────────────────────────────
 * 正式版 DSH 桌面**不是**「插件跑在 Electron 主进程」：主进程 `resources/app/lib/main.js`
 * 只做壳，它 spawn 一个**纯 Node** 宿主进程（`@deepseek-ai/dsh-desktop-host`）来装 DSH
 * 与插件。于是插件里 `process.versions.electron` 是 undefined，`webContents` 拿不到 ——
 * `capturePage()` 只有本模块跑在 Electron 进程里时才成立。下面把它实现完整，**拿不到时
 * 明确说出来**，不假装能推帧。接法（CDP / 桌面壳桥）在 README「还没做什么」里。
 */
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_INTERVAL_MS,
  FRAME_MIME,
  JPEG_QUALITY,
  MAX_BUFFERED_BYTES,
  MAX_EDGE,
  PROTOCOL_VERSION,
  decodeMessage,
  encodeMessage,
  fitWithin,
  mirrorUrl,
  normalizeInput,
  validateFrame,
} from '../contract.js'

export const name = 'dsh-rig-mirror'

/** 三级验证的第三级看这行（宿主启动日志里出现即说明插件真的被 apply 了）。 */
export const MIRROR_STAGE = 'skeleton-1'

const OPEN = 1
const STATS_EVERY_MS = 60_000

const log = (line) => console.log(`[dsh-rig-mirror] ${line}`)

/**
 * 从 config / 环境变量里算出要连的地址。
 * 优先整条 `mirrorUrl`；否则用 `hostPort` + `labId` 现拼（宿主端口在实验室启动时才知道）。
 * 两样都没有就返回 null —— 插件待机，不报错（骨架装进任何 profile 都不该炸）。
 */
export function resolveTarget(config = {}, env = {}) {
  const direct = config.mirrorUrl || env.DSH_RIG_MIRROR_URL || ''
  const token = String(config.token || env.DSH_RIG_MIRROR_TOKEN || '')
  if (direct) return { url: String(direct), labId: String(config.labId || env.DSH_RIG_LAB_ID || '') }
  const port = Number(config.hostPort || env.DSH_RIG_MIRROR_PORT || 0)
  const labId = String(config.labId || env.DSH_RIG_LAB_ID || '').trim()
  if (!Number.isInteger(port) || port <= 0 || labId === '') return null
  return { url: mirrorUrl(`http://127.0.0.1:${port}`, labId, token), labId }
}

/**
 * 输入帧 → Electron `sendInputEvent` 的事件序列。纯函数，不碰 Electron，能单独测。
 * 一次 click 展开成 down+up 两条：Electron 没有「合成点击」这个事件类型。
 */
export function toElectronInputEvents(input) {
  if (input.type === 'key') {
    const type = input.action === 'char' ? 'char' : input.action === 'up' ? 'keyUp' : 'keyDown'
    const event = { type, keyCode: input.key }
    for (const modifier of input.modifiers ?? []) event[modifier] = true
    return [event]
  }
  if (input.type === 'wheel') {
    return [{ type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX ?? 0, deltaY: input.delta ?? 0 }]
  }
  const press = { x: input.x, y: input.y, button: input.button, clickCount: input.clickCount }
  if (input.action === 'move') return [{ type: 'mouseMove', x: input.x, y: input.y }]
  if (input.action === 'down') return [{ type: 'mouseDown', ...press }]
  if (input.action === 'up') return [{ type: 'mouseUp', ...press }]
  return [{ type: 'mouseDown', ...press }, { type: 'mouseUp', ...press }]
}

/**
 * 解析屏幕来源。只有 Electron 进程里可能成功（见文件头），失败返回 `{ ok: false, reason }`。
 */
async function createElectronSurface({ maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
  if (!process.versions.electron) {
    return { ok: false, reason: 'process.versions.electron 缺失：本进程是纯 Node 宿主，不是 Electron' }
  }
  let electron
  try {
    electron = await import('electron')
  } catch (error) {
    return { ok: false, reason: `import('electron') 失败：${error?.message ?? error}` }
  }
  const manager = electron?.webContents
  if (typeof manager?.getAllWebContents !== 'function') return { ok: false, reason: 'electron.webContents 不可用' }
  const page = manager
    .getAllWebContents()
    .find((item) => item.getType?.() === 'window' && item.isDestroyed?.() !== true)
  if (!page) return { ok: false, reason: '没有可截图的窗口 webContents（窗口可能还没建）' }

  const isVisible = () => {
    if (page.isDestroyed?.()) return false
    const window = typeof page.getOwnerBrowserWindow === 'function' ? page.getOwnerBrowserWindow() : null
    if (!window) return true
    if (window.isMinimized?.()) return false
    if (typeof window.isVisible === 'function' && !window.isVisible()) return false
    return true
  }

  const capture = async () => {
    if (page.isDestroyed?.()) return null
    const image = await page.capturePage()
    if (!image || image.isEmpty?.()) return null
    const size = image.getSize()
    const fit = fitWithin(size.width, size.height, maxEdge)
    const scaled =
      fit.w === size.width && fit.h === size.height
        ? image
        : image.resize({ width: fit.w, height: fit.h, quality: 'good' })
    return { bytes: scaled.toJPEG(quality), w: fit.w, h: fit.h }
  }

  const sendInput = (input) => {
    if (page.isDestroyed?.()) return false
    for (const event of toElectronInputEvents(input)) page.sendInputEvent(event)
    return true
  }

  return { ok: true, kind: 'electron', capture, sendInput, isVisible }
}

/** 一次镜像会话：连接、推帧、收输入、重连、暂停、销毁。 */
class MirrorSession {
  constructor({ target, config = {} }) {
    this.target = target
    this.config = config
    this.surface = null
    this.socket = null
    this.timer = null
    this.reconnectTimer = null
    this.statsTimer = null
    this.backoffIndex = 0
    this.seq = 0
    this.capturing = false
    this.pending = null
    this.paused = false
    this.disposed = false
    this.stats = { sent: 0, dropped: 0, inputs: 0, reconnects: 0, errors: 0 }
    this.intervalMs = Math.max(50, Number(config.intervalMs) || DEFAULT_INTERVAL_MS)
    this.backoff = Array.isArray(config.backoffMs) && config.backoffMs.length > 0 ? config.backoffMs : DEFAULT_BACKOFF_MS
  }

  async start() {
    const options = { maxEdge: Number(this.config.maxEdge) || MAX_EDGE, quality: Number(this.config.quality) || JPEG_QUALITY }
    // config.surface 是留好的接缝：接 CDP 适配器或测试替身，形状同 createElectronSurface 的返回值。
    this.surface = typeof this.config.surface === 'function' ? await this.config.surface(options) : await createElectronSurface(options)
    // 帧源不可用时也照连：让宿主看见「插件在、通道通、只是没有帧源」，比静默好排查。
    if (!this.surface.ok) log(`帧源不可用：${this.surface.reason}`)
    if (this.disposed) return
    this.connect()
    this.statsTimer = setInterval(() => this.report(), STATS_EVERY_MS)
    this.statsTimer?.unref?.()
  }

  connect() {
    if (this.disposed) return
    const Impl = this.config.webSocket ?? globalThis.WebSocket
    if (typeof Impl !== 'function') {
      log('本运行时没有全局 WebSocket（需要 Node ≥ 22）；不装依赖、不推帧，插件待机')
      return
    }
    let socket
    try {
      socket = new Impl(this.target.url)
    } catch (error) {
      log(`建立连接失败：${error?.message ?? error}`)
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    if ('binaryType' in socket) socket.binaryType = 'arraybuffer'

    socket.onopen = () => {
      if (this.disposed) return
      this.backoffIndex = 0
      log(`已连上 ${this.target.url}`)
      this.send({
        t: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        plugin: name,
        stage: MIRROR_STAGE,
        surface: this.surface?.ok ? this.surface.kind : 'none',
        reason: this.surface?.ok ? undefined : this.surface?.reason,
      })
      if (this.surface?.ok) {
        if (this.paused) this.send({ t: 'status', paused: true, reason: 'hidden' })
        this.startTicking()
      }
    }
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.handleText(event.data)
      // 宿主不会往插件发二进制；收到就当没看见（不打死连接）。
    }
    socket.onerror = () => { this.stats.errors += 1 }
    socket.onclose = (event) => {
      if (this.disposed) return
      this.stopTicking()
      log(`连接断开（code=${event?.code ?? '?'}），${this.nextDelay()}ms 后重连`)
      this.scheduleReconnect()
    }
  }

  nextDelay() {
    const list = this.backoff
    const index = Math.min(this.backoffIndex, list.length - 1)
    return list[index]
  }

  scheduleReconnect() {
    if (this.disposed || this.reconnectTimer !== null) return
    const delay = this.nextDelay()
    this.backoffIndex = Math.min(this.backoffIndex + 1, this.backoff.length - 1)
    this.stats.reconnects += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer?.unref?.()
  }

  startTicking() {
    if (this.timer !== null || this.disposed) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer?.unref?.()
  }

  stopTicking() {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 一拍：可见才截、上一拍没回来就跳过（不排队——排队就是内存堆积）。 */
  async tick() {
    if (this.disposed || !this.surface?.ok || this.capturing) return
    const visible = this.surface.isVisible()
    if (!visible) {
      if (!this.paused) {
        this.paused = true
        this.pending = null
        log('窗口最小化/隐藏，暂停推帧')
        this.send({ t: 'status', paused: true, reason: 'hidden' })
      }
      return
    }
    if (this.paused) {
      this.paused = false
      log('窗口恢复，继续推帧')
      this.send({ t: 'status', paused: false })
    }
    this.capturing = true
    try {
      const shot = await this.surface.capture()
      if (shot) this.queue(shot)
    } catch (error) {
      this.stats.errors += 1
      log(`截帧失败：${error?.message ?? error}`)
    } finally {
      this.capturing = false
    }
  }

  /** 队列只留 1 帧：新的顶掉旧的（丢旧不丢新，画面永远是最新的那一张）。 */
  queue(shot) {
    if (this.pending !== null) this.stats.dropped += 1
    this.pending = shot
    this.flush()
  }

  flush() {
    const socket = this.socket
    if (this.pending === null || this.disposed) return
    if (!socket || socket.readyState !== OPEN) return
    if (typeof socket.bufferedAmount === 'number' && socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // 发不动就丢：宁可画面卡一拍，也不要缓冲区吃满宿主内存。
      this.pending = null
      this.stats.dropped += 1
      return
    }
    const shot = this.pending
    this.pending = null
    const frame = { seq: this.seq, mime: FRAME_MIME, bytes: shot.bytes.length, w: shot.w, h: shot.h }
    const verdict = validateFrame(frame)
    if (!verdict.ok) {
      this.stats.dropped += 1
      log(`帧元数据不合法（丢）：${verdict.error}`)
      return
    }
    const head = encodeMessage({ t: 'frame', ...verdict.frame })
    if (head === null) {
      this.stats.dropped += 1
      return
    }
    try {
      socket.send(head)
      socket.send(shot.bytes)
      this.seq += 1
      this.stats.sent += 1
    } catch (error) {
      this.stats.errors += 1
      log(`推帧失败：${error?.message ?? error}`)
    }
  }

  send(message) {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return false
    const text = encodeMessage(message)
    if (text === null) return false
    try {
      socket.send(text)
      return true
    } catch {
      return false
    }
  }

  handleText(text) {
    const decoded = decodeMessage(text)
    if (!decoded.ok) {
      this.stats.errors += 1
      return
    }
    const { message } = decoded
    if (message.t === 'bye') {
      log('宿主要求断开，稍后重连')
      try {
        this.socket?.close(1000, 'bye')
      } catch {
        /* 已经关了 */
      }
      return
    }
    if (message.t !== 'input') return
    const normalized = normalizeInput(message.input ?? message)
    if (!normalized.ok) {
      this.stats.errors += 1
      log(`输入不合法（丢）：${normalized.error}`)
      return
    }
    if (!this.surface?.ok) {
      this.stats.dropped += 1
      return
    }
    try {
      if (this.surface.sendInput(normalized.input)) this.stats.inputs += 1
    } catch (error) {
      this.stats.errors += 1
      log(`注入输入失败：${error?.message ?? error}`)
    }
  }

  report() {
    const { sent, dropped, inputs, reconnects, errors } = this.stats
    if (sent === 0 && inputs === 0 && errors === 0) return
    log(`统计 60s：帧 ${sent} · 丢 ${dropped} · 输入 ${inputs} · 重连 ${reconnects} · 错误 ${errors}`)
  }

  /** 幂等：清定时器、关连接、断开事件。宿主停用插件或退出时调用。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.stopTicking()
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    if (this.statsTimer !== null) clearInterval(this.statsTimer)
    this.reconnectTimer = null
    this.statsTimer = null
    this.pending = null
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      try {
        if (socket.readyState === OPEN) socket.close(1000, 'dispose')
      } catch {
        /* 已经关了 */
      }
    }
    log(`已卸载（帧 ${this.stats.sent} · 输入 ${this.stats.inputs}）`)
  }
}

/**
 * 插件入口。**软依赖**：这里不需要任何宿主服务（不 inject webServer / tools），
 * 所以装在哪个 profile 里都不会因为缺服务而待机 —— 它只往外连一条 ws。
 */
export function apply(ctx, config = {}) {
  const target = resolveTarget(config, process.env)
  if (target === null) {
    log('没有配置宿主地址（config.mirrorUrl / DSH_RIG_MIRROR_URL，或 hostPort+labId）—— 待机')
    return
  }
  log(`加载 · stage=${MIRROR_STAGE} · target=${target.url}`)
  const session = new MirrorSession({ target, config })
  const dispose = () => session.dispose()
  void session.start().catch((error) => log(`启动失败：${error?.stack ?? error}`))

  if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, 'dsh-rig-mirror')
  else if (typeof ctx?.on === 'function') ctx.on('dispose', dispose)
}
