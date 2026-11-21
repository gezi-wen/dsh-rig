/**
 * dsh-rig · 路由层冒烟（假 ctx / 假 req / 假 res）
 *
 * 为什么要有这个文件：2026-11-21 加「占用者显示会话标题」时，我把一个闭包里的 `describe`
 * 用在了**模块级函数** `openEventStream` 里。单元测试全绿、`node --check` 也过，
 * 但宿主一启动就是 `ReferenceError: describe is not defined` —— 整个实例起不来。
 *
 * 这类错误（引用了作用域里不存在的东西）只有**真的把 handler 跑一遍**才抓得到。
 * 所以这里不测业务细节，只钉三件事：
 *   1. `GET /state` 能回，且占用者带标题；
 *   2. `GET /events` 的第一帧快照也能回（就是那条崩过的路径）；
 *   3. 被别人占着时，`POST /labs/:id` 回 409 且拒绝文案里是**标题**而不是 id。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { mountRoutes } from '../lib/http/routes.js'

const OWNER = 'session-4f1c2a9e-8b3d-4c11-9f0a-77e2b6d1c333'
const OWNER_TITLE = 'DSH 插件实验室开发规划'

function harness({ ownerSessionId = null, running = false } = {}) {
  const lab = {
    id: 'lab1',
    name: '实验台 lab1',
    version: 'host',
    profile: 'rig-lab1',
    status: running ? 'running' : 'created',
    port: 46000,
    url: running ? 'http://127.0.0.1:46000/?token=abc123' : null,
    ownerSessionId,
    ownerSince: ownerSessionId ? '2026-11-21T10:00:00.000Z' : null,
  }
  const supervisor = {
    list: () => [lab],
    get: () => lab,
    diagnostics: () => ({ labRoot: 'labroot' }),
    uiMode: () => false,
    uiAvailable: async () => ({ available: false, backend: null }),
    subscribe: () => () => {},
    logs: () => ({ entries: [] }),
    // 真的调用回调：占用判定就在回调里，跳过它等于跳过整条链。
    mutate: async (_id, fn) => fn(lab),
    report: async () => ({}),
  }
  let handler = null
  mountRoutes(
    { webServer: { register: (def) => ((handler = def.handler), () => {}) } },
    {
      supervisor,
      versions: { cached: async () => [], remote: async () => ({ versions: [] }) },
      frameSig: 'test-sig',
      titleOf: (id) => (id === OWNER ? OWNER_TITLE : ''),
    },
  )
  assert.ok(handler, 'mountRoutes 必须真的注册一个 handler')
  return { handler, lab }
}

function fakeReq({ method = 'GET', url = '/', headers = {}, body = '' }) {
  const listeners = new Map()
  return {
    method,
    url,
    headers: { 'x-dsh-rig': '1', ...headers },
    listeners,
    on(event, fn) {
      listeners.set(event, fn)
      return this
    },
    destroy() {},
    flush() {
      if (body !== '') listeners.get('data')?.(Buffer.from(body))
      listeners.get('end')?.()
    },
    /** SSE 的 handler 会挂心跳 interval；不主动 close 的话测试进程永远不退出。 */
    close() {
      listeners.get('close')?.()
    },
  }
}

function fakeRes() {
  return {
    status: 0,
    headers: {},
    chunks: [],
    ended: false,
    writeHead(code, headers) {
      this.status = code
      this.headers = headers || {}
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      this.ended = true
      if (chunk) this.chunks.push(String(chunk))
    },
    on() {},
    get body() {
      return this.chunks.join('')
    },
  }
}

const jitter = () => new Promise((resolve) => setTimeout(resolve, 30))

test('路由：GET /state 回 200，占用者带标题', async () => {
  const { handler } = harness({ ownerSessionId: OWNER })
  const res = fakeRes()
  await handler(fakeReq({ url: '/dsh-rig/api/state' }), res)
  assert.equal(res.status, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.labs[0].ownerTitle, OWNER_TITLE, '占用者必须带标题，前端才不用靠 id 猜人')
  assert.equal(payload.frameSig, 'test-sig')
})

test('路由：GET /events 第一帧快照能回（闭包变量漏传会把整个宿主拖死）', async () => {
  const { handler } = harness({ ownerSessionId: OWNER })
  const res = fakeRes()
  const req = fakeReq({ url: '/dsh-rig/api/events' })
  handler(req, res)
  await jitter()
  try {
    assert.equal(res.status, 200)
    assert.match(res.body, /"type":"snapshot"/u)
    assert.match(res.body, /"ownerTitle":"DSH 插件实验室开发规划"/u)
  } finally {
    req.close() // 关掉心跳，否则 node --test 不退出
  }
})

test('路由：被别人占着 → 409，拒绝文案里是标题不是 id', async () => {
  const { handler } = harness({ ownerSessionId: OWNER })
  const res = fakeRes()
  const req = fakeReq({
    method: 'POST',
    url: '/dsh-rig/api/labs/lab1',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'start', sessionId: 'session-ffffffff-0000' }),
  })
  const done = handler(req, res)
  req.flush()
  await done
  assert.equal(res.status, 409)
  const payload = JSON.parse(res.body)
  assert.match(payload.error, /DSH 插件实验室开发规划/u)
  assert.equal(payload.owner, OWNER, '占用者 id 也要带回去，面板要拿它做比对')
})

test('路由：缺 x-dsh-rig 头一律 403（防别的网页顺手打你的实验室）', async () => {
  const { handler } = harness()
  const res = fakeRes()
  await handler(fakeReq({ url: '/dsh-rig/api/state', headers: { 'x-dsh-rig': '' } }), res)
  assert.equal(res.status, 403)
})

// ── /frame：iframe 必须与宿主同站，否则实验室的 SameSite=Strict 登录 cookie 存不下 ──

const frameOf = (host, { running = true, sig = 'test-sig' } = {}) => {
  const { handler } = harness({ running })
  const res = fakeRes()
  handler(fakeReq({ url: `/dsh-rig/api/frame?id=lab1&sig=${sig}&n=1`, headers: { host } }), res)
  return res
}

test('/frame：主机名跟着请求走（localhost 页面就 302 到 localhost:46000）', () => {
  const res = frameOf('localhost:63425')
  assert.equal(res.status, 302)
  const location = res.headers.location
  assert.match(location, /^http:\/\/localhost:46000\/\?token=abc123$/u, `实际：${location}`)
})

test('/frame：127.0.0.1 的页面仍然 302 到 127.0.0.1（端口与 token 不变）', () => {
  const res = frameOf('127.0.0.1:63425')
  assert.equal(res.status, 302)
  assert.match(res.headers.location, /^http:\/\/127\.0\.0\.1:46000\/\?token=abc123$/u)
})

test('/frame：坏签名 403、没运行 503（两者都不该把 iframe 带到实验室）', () => {
  assert.equal(frameOf('localhost:63425', { sig: 'wrong' }).status, 403)
  const idle = frameOf('localhost:63425', { running: false })
  assert.equal(idle.status, 503)
  assert.match(idle.body, /实验室未运行/u)
})
