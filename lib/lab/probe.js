/**
 * dsh-rig · 存活探针（IO 层）
 *
 * **用 `node:http`，不用 `fetch`。** 宿主进程里的全局 `fetch` 不是原生那个 ——
 * DSH 自己接管了它（`ctx.connection` 的共享 fetch handler），拿去请求一个外部回环端口会直接失败。
 * 2026-11-21 实测：同一个 URL，PowerShell 的 `Invoke-WebRequest` 回 200，宿主进程内 `fetch`
 * 报 `fetch failed`，于是「实验室明明起来了」被探针连续判死 60 秒、然后被我们杀掉。
 *
 * 判据：**只要拿到任何 HTTP 状态码就算活着**。401（缺 token）、404（根路径变了）都证明进程在听；
 * 进程死了由 `exit` 事件负责，不靠探针猜。
 */
import { request } from 'node:http'

export function probeOnce(url, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok, reason) => {
      if (settled) return
      settled = true
      resolve({ ok, reason })
    }
    let target
    try {
      target = new URL(url)
    } catch {
      done(false, 'URL 解析失败')
      return
    }
    let req
    try {
      req = request(
        {
          hostname: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          timeout: timeoutMs,
        },
        (res) => {
          res.resume()
          const code = res.statusCode ?? 0
          done(code > 0, `HTTP ${code}`)
        },
      )
    } catch (err) {
      done(false, String(err?.message ?? err))
      return
    }
    req.on('timeout', () => {
      req.destroy()
      done(false, '超时')
    })
    req.on('error', (err) => done(false, String(err?.message ?? err)))
    req.end()
  })
}
