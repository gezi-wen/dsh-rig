/**
 * dsh-rig · 无头浏览器与 CDP 通道（IO 层）
 *
 * 用途：让**智能体**能像人一样操作实验室 —— 点按钮、开设置、打字、截图。
 *
 * 为什么不引 Playwright：
 *   - 那是几百 MB 的依赖 + 浏览器二进制，为一个右栏面板不值得；
 *   - 本机已经有 Edge/Chrome，Chromium 自带 CDP，Node 24 自带全局 `WebSocket`。
 * 所以这里只用 `node:child_process` + 内置 WebSocket 说 DevTools 协议，**零 npm 依赖**。
 *
 * 一条实测得来的纪律：**按「文字/可访问名」找元素，别按 CSS 选择器**。
 * 选择器会随界面改版失效，而「按钮叫『设置』」这件事相对稳定；找不到就把现场候选名报回去，
 * 让调用方自己改口，而不是静默点空。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

/** 等待浏览器把 DevTools 端口报出来的上限。冷启动一般 1–3 秒。 */
const LAUNCH_TIMEOUT_MS = 20_000

/** 找本机浏览器。只认 Edge / Chrome 的默认安装位与显式环境变量。 */
export function findBrowserExecutable(env = process.env) {
  const fromEnv = env.DSH_RIG_BROWSER
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  const candidates = [
    join(env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const file of candidates) {
    if (file && existsSync(file)) return file
  }
  return null
}

function join(...parts) {
  return parts.filter(Boolean).join('\\')
}

/** 取 `/json/list` 里的页面目标（只用 node:http，免得被宿主接管的 fetch 影响）。 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = httpRequest(
      { hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET', timeout: 5_000 },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (err) {
            reject(new Error(`DevTools JSON 解析失败：${err?.message ?? err}`))
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('DevTools HTTP 超时'))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 一个最小 CDP 连接：只实现 send / on / close。
 * 不引 ws 包 —— Node 22+ 自带全局 WebSocket。
 */
class CdpConnection {
  #ws
  #nextId = 1
  #pending = new Map()
  #handlers = new Map()

  static async open(wsUrl) {
    const conn = new CdpConnection()
    conn.#ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10_000)
      conn.#ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      conn.#ws.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error(`CDP 连接失败：${event?.message ?? 'unknown'}`))
      })
    })
    conn.#ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      if (msg.id && conn.#pending.has(msg.id)) {
        const { resolve, reject } = conn.#pending.get(msg.id)
        conn.#pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || 'CDP 调用失败'))
        else resolve(msg.result)
        return
      }
      if (msg.method) {
        for (const fn of conn.#handlers.get(msg.method) || []) {
          try {
            fn(msg.params)
          } catch {
            /* 订阅者出错不影响连接 */
          }
        }
      }
    })
    return conn
  }

  send(method, params = {}) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      try {
        this.#ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        this.#pending.delete(id)
        reject(err)
      }
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id)
          reject(new Error(`CDP ${method} 超时`))
        }
      }, 20_000)
    })
  }

  on(method, fn) {
    const list = this.#handlers.get(method) || []
    list.push(fn)
    this.#handlers.set(method, list)
  }

  close() {
    try {
      this.#ws.close()
    } catch {
      /* 已关 */
    }
  }
}

/**
 * 起一个无头浏览器并连到指定页面。
 *
 * @returns {Promise<{conn: CdpConnection, child: import('node:child_process').ChildProcess, kill: () => void}>}
 */
export async function launchBrowser({ browserPath, labUrl, userDataDir, width = 1280, height = 900 }) {
  if (!browserPath) throw new Error('没找到 Edge/Chrome：可用 DSH_RIG_BROWSER 指定可执行文件')
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--window-size=${width},${height}`,
    labUrl,
  ]
  const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })

  const wsBase = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('浏览器没有在时限内报出 DevTools 端口')), LAUNCH_TIMEOUT_MS)
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      buffer += chunk
      const m = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(buffer)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`浏览器提前退出（code ${code ?? 'null'}）`))
    })
  })

  const { port } = new URL(wsBase)
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`)
  const page = targets.find((t) => t.type === 'page') || targets[0]
  if (!page?.webSocketDebuggerUrl) throw new Error('浏览器没有可用的页面目标')
  const conn = await CdpConnection.open(page.webSocketDebuggerUrl)
  await conn.send('Page.enable')
  await conn.send('Runtime.enable')

  return {
    conn,
    child,
    kill() {
      conn.close()
      try {
        child.kill()
      } catch {
        /* 已退 */
      }
    },
  }
}
