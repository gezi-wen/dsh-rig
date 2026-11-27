/**
 * dsh-rig · 内桥探针 v2（装进实验室）
 *
 * v1 只报形状。v2 按官方调用点补齐了真实能力：
 *   agents.create({ sessionId, agentOptions, meta: { cwd } })   ← 与 dsh-headless / api-session-controller 同形
 *   agent.followup(createUserMessage({ content: [{type:'text',text}], source:{kind:'user'} }))   ← 与官方提交点同形
 *
 * 端点：
 *   GET  /bridge/health
 *   GET  /bridge/shape
 *   POST /bridge/send   { sessionId?, text, cwd? }  → 建会话（没有就建）+ 投一条用户消息
 *   POST /bridge/probe  { text }                    → 只在已有会话上试形状（不新建）
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const VERSION = '0.0.2'
const DEFAULT_SESSION = 'rig-bridge'

function describe(target) {
  if (!target || typeof target !== 'object') return { type: typeof target }
  const names = new Set()
  let cursor = target
  let depth = 0
  while (cursor && cursor !== Object.prototype && depth < 4) {
    for (const name of Object.getOwnPropertyNames(cursor)) if (name !== 'constructor') names.add(name)
    cursor = Object.getPrototypeOf(cursor)
    depth += 1
  }
  const methods = []
  for (const name of names) {
    try {
      const value = target[name]
      if (typeof value === 'function') methods.push(`${name}/${value.length}`)
    } catch {
      /* getter 抛错不是重点 */
    }
  }
  return { methods: methods.sort() }
}

/** 建会话（已存在就直接返回）。agentOptions 跟着宿主默认模型走，和 web 端“新会话”一致。 */
async function ensureAgent(ctx, sessionId, cwd) {
  const existing = ctx.agents.get(sessionId)
  if (existing) return { agent: existing, created: false }
  // 盘上已有这个会话（重启过的实验室）→ 必须先 resume；直接 create 会 SessionAlreadyExistsError。
  try {
    const resumed = await ctx.agents.resume({ resumeSessionId: sessionId })
    return { agent: resumed?.agent ?? resumed, created: false, resumed: true }
  } catch {
    /* 盘上没有，走 create */
  }
  const defaults = ctx.agentDefaultModel
  const selection = () => (defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : null)
  const result = await ctx.agents.create({
    sessionId,
    agentOptions: defaults
      ? {
          get provider() {
            return selection()?.provider
          },
          get model() {
            return selection()?.model
          },
        }
      : undefined,
    meta: { cwd: cwd || process.cwd() },
  })
  return { agent: result?.agent ?? result, created: true }
}

export const inject = ['agents', 'webServer', 'agentDefaultModel']

export function apply(ctx) {
  console.log(`[rig-bridge] v${VERSION} 已加载；agents = ${JSON.stringify(describe(ctx.agents))}`)

  const json = (res, status, body) => {
    const text = JSON.stringify(body, null, 2)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > 64 * 1024) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  ctx.webServer.register({
    kind: 'prefix',
    path: '/bridge',
    async handler(req, res) {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const tail = url.pathname.replace(/^\/bridge/u, '') || '/'
      try {
        if (tail === '/health') return json(res, 200, { ok: true, v: VERSION })
        if (tail === '/shape') {
          return json(res, 200, {
            agents: describe(ctx.agents),
            live: (ctx.agents.list?.() ?? []).map((item) => ({ id: item?.id ?? item?.sessionId ?? null, shape: describe(item) })),
            hasDefaultModel: Boolean(ctx.agentDefaultModel),
          })
        }
        if (tail === '/send' && req.method === 'POST') {
          const body = await readBody(req)
          const text = String(body.text || '').trim()
          if (!text) return json(res, 400, { error: 'text 不能为空' })
          const sessionId = String(body.sessionId || DEFAULT_SESSION)
          const started = Date.now()
          const { agent, created } = await ensureAgent(ctx, sessionId, body.cwd)
          const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
          agent.followup(message)
          const receipt = { ok: true, sessionId, created, messageId: message.id ?? null, ms: Date.now() - started }
          if (!body.wait) return json(res, 200, receipt)
          // wait：等到这一轮跑完再回，智能体因此能「派活 → 知道干完了」。
          const waitStart = Date.now()
          const budget = Math.min(Number(body.timeoutMs) || 180_000, 600_000)
          await Promise.race([agent.whenIdle(), new Promise((r) => setTimeout(r, budget))])
          return json(res, 200, { ...receipt, waitedMs: Date.now() - waitStart, idle: agent.status === 'idle' })
        }
        json(res, 404, { error: 'not found' })
      } catch (err) {
        json(res, 500, { error: String(err?.stack ?? err) })
      }
    },
  })
}
