/**
 * dsh-rig · CDP 会话（IO 层）
 *
 * 实验室的桌面实例只通过 CDP 说话：**拿画面**（`Page.captureScreenshot`）、**派输入**（`Input.*`）。
 *
 * 为什么不是「插件里推帧」：正式版桌面把 DSH 跑在 `@deepseek-ai/dsh-desktop-host` 里
 * （Electron 二进制 + `ELECTRON_RUN_AS_NODE`），插件处在纯 Node 上下文 ——
 * `process.versions.electron` 为真，但 `require('electron')` 给不出 BrowserWindow，
 * `webContents.capturePage()` / `sendInputEvent()` 都拿不到。这一条 2026-11-24 实测确认。
 *
 * 为什么不是「抓窗口 + OS 级注入」：那要 Win SendInput / mac CGEvent / Linux uinput 三套代码
 * 加两套系统权限，而 CDP 三平台同一套、零权限。
 *
 * 代价（要写进 README）：看不到窗口装饰与壳自己的原生弹窗。DSH 的 UI 全在 renderer 里，够用。
 */
import { setTimeout as delay } from 'node:timers/promises'

/** 界面就绪的判据取样：壳在 target 出现之后还要几秒才把插件加载完。 */
const READY_SAMPLE = 'document.body && document.body.innerText ? document.body.innerText.slice(0, 400) : ""'
/** 还在加载时 body 里长这样（2026-11-24 实测：`HARNESS` + `Loading plugins...`）。 */
const STILL_LOADING = /Loading plugins/iu

export class CdpError extends Error {}

/**
 * 连上一个已经开了 `--remote-debugging-port` 的桌面实例，并等界面可用。
 *
 * @param {{port: number, log?: (line: string) => void, readyTimeoutMs?: number, openTimeoutMs?: number}} options
 * @returns {Promise<CdpSession>}
 */
export async function openCdp(options) {
  const { port, log = () => {}, readyTimeoutMs = 90_000, openTimeoutMs = 45_000 } = options
  const target = await waitForPage(port, openTimeoutMs, log)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await waitOpen(ws, 15_000)
  const session = new CdpSession(ws, log)
  // `Page.enable` 打底：不开这个域时 `Page.captureScreenshot` 实测会**永不返回**
  // （2026-11-24：裸通道先 enable 就正常，封装里没 enable 就 20 秒超时）。
  await session.send('Page.enable').catch((err) => log(`[dsh-rig] Page.enable 失败（继续）：${err?.message ?? err}`))
  // 让页面相信自己有焦点：实验室窗口永远在正式版后面，没有这一步时点击不触发重绘
  // （实测：不加时点击后 0 帧，加上后 4 帧）。
  await session
    .send('Emulation.setFocusEmulationEnabled', { enabled: true })
    .catch((err) => log(`[dsh-rig] 焦点仿真失败（继续）：${err?.message ?? err}`))
  await session.waitReady(readyTimeoutMs)
  return session
}

/**
 * 等 `GET /json/list` 里出现一个 page target。
 *
 * 端口开得比页面早就绪：壳先起 DevTools 监听，再加载 renderer。所以这里必须轮询，
 * 而且不能把「暂时没有 page」当成失败。
 */
async function waitForPage(port, timeoutMs, log) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) {
        const list = await res.json()
        const page = Array.isArray(list) ? list.find((item) => item && item.type === 'page' && item.webSocketDebuggerUrl) : null
        if (page) return page
      }
    } catch (err) {
      lastError = String(err?.message ?? err)
    }
    await delay(300)
  }
  throw new CdpError(`CDP 端口 ${port} 上没有可用的页面（${lastError || '超时'}）`)
}

function waitOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CdpError('CDP WebSocket 连接超时')), timeoutMs)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new CdpError('CDP WebSocket 连接失败'))
    }
  })
}

export class CdpSession {
  #ws
  #log
  #seq = 1
  #pending = new Map()
  #listeners = new Map()
  #closed = false
  #viewport = null

  constructor(ws, log) {
    this.#ws = ws
    this.#log = log
    ws.onmessage = (event) => this.#onMessage(event)
    ws.onclose = () => {
      this.#closed = true
      for (const [, entry] of this.#pending) entry.reject(new CdpError('CDP 连接已关闭'))
      this.#pending.clear()
    }
  }

  get closed() {
    return this.#closed
  }

  #onMessage(event) {
    const raw = event?.data
    // Node 的 WebSocket 实现里二进制帧可能是 Blob/ArrayBuffer；CDP 全是文本帧，
    // 但先按「能拿文本就拿文本」处理，别让一帧解析不了就静默吞掉整条响应。
    if (typeof raw === 'string') this.#handle(raw)
    else if (raw && typeof raw.text === 'function') void raw.text().then((text) => this.#handle(text)).catch(() => {})
    else this.#handle(String(raw))
  }

  #handle(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch (err) {
      this.#log(`[dsh-rig] CDP 帧解析失败：${err?.message ?? err}`)
      return
    }
    if (!message) return
    if (typeof message.id === 'number') {
      const entry = this.#pending.get(message.id)
      if (!entry) return
      this.#pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new CdpError(`${entry.method}: ${message.error.message || 'unknown'}`))
      else entry.resolve(message.result)
      return
    }
    if (typeof message.method === 'string') {
      const listeners = this.#listeners.get(message.method)
      if (!listeners) return
      for (const fn of listeners) {
        try {
          fn(message.params || {})
        } catch (err) {
          this.#log(`[dsh-rig] CDP 事件 ${message.method} 处理失败：${err?.message ?? err}`)
        }
      }
    }
  }

  /** 订阅一个 CDP 事件。返回取消订阅函数。 */
  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set())
    this.#listeners.get(method).add(fn)
    return () => this.#listeners.get(method)?.delete(fn)
  }

  /**
   * 持续帧流（`Page.startScreencast`），而不是一次一次 `captureScreenshot`。
   *
   * 为什么必须换：`captureScreenshot` 是「抓当前合成一帧」，窗口被遮挡或页面停止重绘时
   * **它会一直等下去**（2026-11-24 实测：点击之后第二次截图 20 秒不返回，连接却是 OPEN）。
   * screencast 由渲染进程主动推帧，天然不依赖「窗口可见」，代价是要逐帧 ack。
   *
   * @param {{quality?: number, maxWidth?: number, maxHeight?: number, everyNthFrame?: number, onFrame: (frame: {data: string, metadata: object}) => void}} options
   */
  async startScreencast(options) {
    const { quality = 60, maxWidth = 1280, maxHeight = 800, everyNthFrame = 1, onFrame } = options
    this.on('Page.screencastFrame', (params) => {
      try {
        // metadata.deviceWidth/deviceHeight 是页面坐标；viewportScale 是设备像素比。
        onFrame({ data: params.data, metadata: params.metadata || {} })
      } finally {
        // 不 ack 就不推下一帧 —— 这是 screencast 的流控，漏了会静默停流。
        void this.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {})
      }
    })
    await this.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame })
  }

  async stopScreencast() {
    await this.send('Page.stopScreencast').catch(() => {})
  }

  /** 发一条 CDP 命令。每次调用独立超时，避免一条卡死的命令拖住整条会话。 */
  send(method, params = {}, timeoutMs = 15_000) {
    if (this.#closed) return Promise.reject(new CdpError('CDP 连接已关闭'))
    const id = this.#seq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        this.#log(`[dsh-rig] CDP ${method} 超时（${timeoutMs}ms，连接状态=${this.#ws.readyState}）`)
        reject(new CdpError(`${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new CdpError(`${method} 发送失败：${err?.message ?? err}`))
      }
    })
  }

  async #bodyText() {
    const result = await this.send('Runtime.evaluate', { expression: READY_SAMPLE, returnByValue: true })
    return String(result?.result?.value ?? '')
  }

  /**
   * 等界面可用。
   *
   * `target 出现 ≠ 界面可用`：2026-11-24 实测，target 一出现就截图，抓到的是
   * 「HARNESS / Loading plugins...」那张启动页。判据必须是 renderer 自己说加载完了。
   */
  async waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let waited = 0
    while (Date.now() < deadline) {
      const text = await this.#bodyText().catch(() => '')
      if (text && !STILL_LOADING.test(text)) {
        this.#log(`[dsh-rig] 实验室界面就绪（${Math.round(waited / 1000)}s）`)
        return true
      }
      await delay(1000)
      waited += 1000
    }
    this.#log(`[dsh-rig] 实验室界面 ${Math.round(timeoutMs / 1000)}s 未就绪，继续但不保证有画面`)
    return false
  }

  /** 当前可视区尺寸（CSS px）。输入坐标按它换算，不按窗口像素。 */
  async viewport(refresh = false) {
    if (this.#viewport && !refresh) return this.#viewport
    const metrics = await this.send('Page.getLayoutMetrics', {})
    const box = metrics?.cssVisualViewport || metrics?.visualViewport || {}
    const size = {
      width: Math.max(1, Math.round(box.clientWidth || box.width || 1280)),
      height: Math.max(1, Math.round(box.clientHeight || box.height || 800)),
      scale: box.scale || 1,
    }
    this.#viewport = size
    return size
  }

  /** 截一帧 JPEG。返回 Buffer。 */
  async screenshot(quality = 70) {
    const result = await this.send('Page.captureScreenshot', { format: 'jpeg', quality }, 20_000)
    if (!result?.data) throw new CdpError('截图返回空')
    return Buffer.from(result.data, 'base64')
  }

  /** 鼠标：move / down / up / click（click = down+up 一次，自带 clickCount）。 */
  async pointer(event) {
    const { type, x, y, button = 'left', clickCount = 1 } = event
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CdpError('指针坐标非法')
    if (type === 'click') {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount })
      return
    }
    const map = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }
    const name = map[type]
    if (!name) throw new CdpError(`未知指针事件 ${type}`)
    await this.send('Input.dispatchMouseEvent', { type: name, x, y, button, clickCount })
  }

  /** 滚轮：CDP 要的是像素增量，不是「格数」。 */
  async wheel({ x, y, deltaX = 0, deltaY = 0 }) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
  }

  /**
   * 文字输入。
   *
   * 用 `Input.insertText` 而不是逐键 `char`：中文与 IME 场景下逐键会散架，
   * 而这个命令直接把一段文本插进焦点元素 —— 与粘贴等价，正是我们要的语义。
   */
  async text(value) {
    if (!value) return
    await this.send('Input.insertText', { text: String(value) })
  }

  /** 单个按键（enter / tab / arrows / esc 等）。key 用 DOM 键盘事件的名字。 */
  async key({ key, code, windowsVirtualKeyCode, modifiers = 0 }) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      modifiers,
    })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers })
  }

  close() {
    if (this.#closed) return
    this.#closed = true
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new CdpError('CDP 会话已关闭'))
    }
    this.#pending.clear()
    try {
      this.#ws.close()
    } catch {
      /* 已经断了 */
    }
  }
}
