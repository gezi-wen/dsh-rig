/**
 * dsh-rig · 端口（IO 层）
 *
 * 为什么值得单独管：实验室原来用 `--port 0` 让系统随机分配，于是**每启动一次都换一个 origin**。
 * 对浏览器来说换 origin 就是换一个世界：localStorage / sessionStorage / cookie 全部重来，
 * 而 DSH 的网页端会把登录态记在自己的 origin 下 —— 这就是「重启之后内嵌视图要我重新登录」的根源。
 * 固定端口把它变成同一个 origin，重启只是刷一次页面，不再丢登录态。
 */
import { createServer } from 'node:net'

/** 这个端口现在能不能占（bind 一下再释放）。 */
export function isPortFree(port) {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      resolve(false)
      return
    }
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/**
 * 从 start 开始找一个空闲端口（最多试 span 个）。
 * @returns {Promise<number|null>} 找不到返回 null，由调用方回落 `--port 0`
 */
export async function pickFreePort(start, span = 40) {
  for (let port = start; port < start + span; port += 1) {
    if (await isPortFree(port)) return port
  }
  return null
}
