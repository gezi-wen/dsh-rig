/**
 * dsh-rig · HTTP 边（同源，给面板用）
 *
 * 为什么走宿主 `ctx.webServer` 而不是 typert remote：面板要的是**流**（日志一行一行推）
 * 与一个稳定前缀，而 typert 的 manifest 手写必漂（技能里那条 2026-10-01 的实测）。
 * 同一条前缀下做内部小路由，比注册一堆 exact 路径更好改。
 *
 * 安全：这些路由不在 `/api` 信任栅栏后面（栅栏只管 `/api/*`），所以自己加一道：
 *   - 只认带 `x-dsh-rig: 1` 头的请求 —— 跨站页面发不出这个头（要过 CORS 预检，而我们不给 CORS）；
 *   - 服务只绑 127.0.0.1（宿主本来就只监听回环）。
 * 这不是强安全边界，是防「别的网页顺手打你的实验室」。真正的边界是「它只在本机」。
 */
import { API_PREFIX } from '../lab/constants.js'
import { reapOrphans } from '../lab/orphans.js'
import { claimOwner, releaseOwner } from '../lab/ownership.js'
import { guardDrive, isDriveAction } from '../lab/drive-guard.js'

const MAX_BODY_BYTES = 64 * 1024

const json = (res, code, value) => {
  const body = JSON.stringify(value ?? null)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })

/** SSE：面板挂一条长连接，状态与日志都从这条推。 */
function openEventStream(req, res, supervisor, frameSig) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  const send = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      /* 客户端已走 */
    }
  }
  void (async () => {
    const ui = await supervisor.uiAvailable()
    send({ type: 'snapshot', labs: supervisor.list(), diagnostics: supervisor.diagnostics(), uiMode: supervisor.uiMode(), ui, frameSig })
  })()
  const unsubscribe = supervisor.subscribe(send)
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      /* ignore */
    }
  }, 15_000)
  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}

export function mountRoutes(ctx, { supervisor, versions, frameSig }) {
  /**
   * iframe 用的稳定入口签名（由组合根生成并传入，路由层不自己造随机数）。
   *
   * 为什么要它：实验室每次重启都会换端口与 token，而 iframe 的 src 一旦写死旧地址，
   * 就会被实验室自己的鉴权打回 401（2026-11-21 第一次真机试用就撞上：
   * 面板里显示 "dsh web authentication required"）。
   * 现在 iframe 指向 `/dsh-rig/api/frame?id=…&sig=…`，由宿主**每次现查**实验室的真地址再 302，
   * 于是「端口变了」「token 轮换了」「面板状态旧了一拍」都不再能把它带偏。
   *
   * 它不是安全边界（同机进程本来就能伪造请求头），只是让 UI 不会拿着过期地址。
   */
  const frameRoute = (res, url) => {
    const id = url.searchParams.get('id') || ''
    const sig = url.searchParams.get('sig') || ''
    if (sig !== frameSig) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('bad signature')
      return
    }
    const lab = supervisor.get(id)
    if (!lab || !lab.url) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;color:#8a93a5;background:#0f1115;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">实验室未运行 —— 点「启动」后这里会自动接上</body>',
      )
      return
    }
    // 302 到**此刻**的真地址：端口与 token 每次重启都会变，这里现查现给。
    res.writeHead(302, { location: lab.url, 'cache-control': 'no-store' })
    res.end()
  }

  /**
   * 驾驶校验：动手才 claim（打开面板不占坑）。
   * 被别的会话占着时返回 409，并把占用者 id 带回去 —— 面板据此把主按钮换成「接手」。
   */
  const requireDrive = async (res, id, body, force) => {
    const verdict = await supervisor.mutate(id, (lab) =>
      guardDrive(lab, String(body?.sessionId || ''), { force: Boolean(force ?? body?.force) }),
    )
    if (verdict.allow) return true
    json(res, 409, { error: verdict.reason, owner: verdict.owner || null })
    return false
  }

  return ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    async handler(req, res) {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const tail = url.pathname.slice(API_PREFIX.length) || '/'
      const method = req.method || 'GET'

      // iframe 导航**带不了自定义请求头**，所以这一条必须放在头校验之前。
      if (tail === '/frame') {
        frameRoute(res, url)
        return
      }

      if (req.headers['x-dsh-rig'] !== '1') {
        json(res, 403, { error: 'missing x-dsh-rig header' })
        return
      }

      try {
        if (method === 'GET' && tail === '/state') {
          const ui = await supervisor.uiAvailable()
          json(res, 200, {
            labs: supervisor.list(),
            diagnostics: supervisor.diagnostics(),
            ui,
            uiMode: supervisor.uiMode(),
            frameSig,
          })
          return
        }
        if (method === 'GET' && tail === '/events') {
          openEventStream(req, res, supervisor, frameSig)
          return
        }
        if (method === 'POST' && tail === '/ui-mode') {
          const body = await readBody(req)
          const enabled = supervisor.setUiMode(Boolean(body.enabled))
          json(res, 200, { uiMode: enabled })
          return
        }
        if (method === 'GET' && tail === '/logs') {
          const id = url.searchParams.get('id') || ''
          const since = Number(url.searchParams.get('since') || 0)
          json(res, 200, supervisor.logs(id, since))
          return
        }
        if (method === 'GET' && tail === '/versions') {
          const cached = await versions.cached()
          const remote = url.searchParams.get('remote') === '1' ? await versions.remote() : null
          json(res, 200, { cached, remote })
          return
        }
        if (method === 'POST' && tail === '/labs') {
          const body = await readBody(req)
          const lab = await supervisor.create({ name: body.name, version: body.version })
          if (body.sessionId) {
            await supervisor.mutate(lab.id, (record) => guardDrive(record, String(body.sessionId), { force: true }))
          }
          json(res, 200, { lab, labs: supervisor.list() })
          return
        }
        const action = /^\/labs\/([a-z0-9-]+)$/u.exec(tail)
        if (method === 'POST' && action) {
          const id = action[1]
          const body = await readBody(req)
          const verb = String(body.action || '')
          if (isDriveAction(verb) && !(await requireDrive(res, id, body))) return
          let result = null
          if (verb === 'start') result = await supervisor.start(id)
          else if (verb === 'stop') result = await supervisor.stop(id)
          else if (verb === 'restart') result = await supervisor.restart(id)
          else if (verb === 'destroy') result = await supervisor.destroy(id)
          else {
            json(res, 400, { error: `未知动作 ${verb}` })
            return
          }
          json(res, 200, { result, labs: supervisor.list() })
          return
        }
        // 孤儿实验室：宿主被硬杀时留下的进程。只列不杀，除非显式要求回收。
        if (method === 'GET' && tail === '/orphans') {
          const tracked = supervisor.list().filter((lab) => lab.status === 'running' || lab.status === 'starting')
          const result = await reapOrphans({ trackedProfileNames: tracked.map((lab) => lab.profile), dryRun: true })
          json(res, 200, { orphans: result.found })
          return
        }
        if (method === 'POST' && tail === '/orphans/reap') {
          const tracked = supervisor.list().filter((lab) => lab.status === 'running' || lab.status === 'starting')
          const result = await reapOrphans({ trackedProfileNames: tracked.map((lab) => lab.profile) })
          json(res, 200, result)
          return
        }
        // 占用：实验室是全局资源、面板是会话级，所以要说清「谁在驾驶」。
        const claimTarget = /^\/labs\/([a-z0-9-]+)\/(claim|release)$/u.exec(tail)
        if (method === 'POST' && claimTarget) {
          const body = await readBody(req)
          const verb = claimTarget[2]
          const sessionId = String(body.sessionId || '')
          const result = await supervisor.mutate(claimTarget[1], (lab) =>
            verb === 'claim' ? claimOwner(lab, sessionId, { force: Boolean(body.force) }) : { ok: true, changed: releaseOwner(lab) },
          )
          json(res, result.ok === false ? 409 : 200, result)
          return
        }
        // 界面驱动：让智能体像人一样看/拍/点/打（面板与工具共用这条）
        const reportTarget = /^\/labs\/([a-z0-9-]+)\/report$/u.exec(tail)
        if (method === 'GET' && reportTarget) {
          json(res, 200, { report: await supervisor.report(reportTarget[1]) })
          return
        }
        const versionTarget = /^\/labs\/([a-z0-9-]+)\/version$/u.exec(tail)
        if (method === 'POST' && versionTarget) {
          const body = await readBody(req)
          if (!(await requireDrive(res, versionTarget[1], body))) return
          const lab = await supervisor.setVersion(versionTarget[1], String(body.version || 'host'))
          json(res, 200, { lab, labs: supervisor.list() })
          return
        }
        const uiTarget = /^\/labs\/([a-z0-9-]+)\/ui$/u.exec(tail)
        if (method === 'POST' && uiTarget) {
          const body = await readBody(req)
          if (!(await requireDrive(res, uiTarget[1], body))) return
          const result = await supervisor.ui(uiTarget[1], String(body.action || ''), body.args || body)
          json(res, 200, { result })
          return
        }
        json(res, 404, { error: `没有这条路由：${method} ${tail}` })
      } catch (err) {
        json(res, 500, { error: String(err?.message ?? err) })
      }
    },
  })
}
