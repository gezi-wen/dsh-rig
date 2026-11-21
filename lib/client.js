/**
 * dsh-rig · client half — 右栏「插件实验室」面板
 *
 * ⚠️ 这个文件是**一个 ModuleLoader bundle**：协议上没法拆成多文件（factory 只能 require 宿主导出的模块）。
 * 所以「组件化」靠文件内分区保证，顺序固定：常量 → 样式 → 图标 → 通信 → 页级 store → hook → 原子组件 → 三带 → 容器 → 注册。
 * 结构守卫（test/structure.test.mjs）盯着它的行长上限与 API 前缀对拍。
 *
 * 四件事：事件流是页级单例（面板没开时也要能收到 `open-lab`）；iframe 指向宿主稳定入口而非实验室裸地址；
 * 占用靠「动手才 claim」；锁定只挡输入，不是安全边界。
 */
window.__ModuleLoader__.load({
  id: 'dsh-rig',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef } = React

    // ── 1. 常量与文案 ──────────────────────────────────────────────
    const TAB_ID = 'dsh-rig'
    const TAB_KIND = 'dsh-rig:lab'
    const GUIDE_ORDER = 45
    /** 与宿主侧 `lib/lab/constants.js` 的 API_PREFIX 一致，由结构守卫 4b 对拍。 */
    const API = '/dsh-rig/api'
    const HEADERS = { 'x-dsh-rig': '1' }
    const LOG_TAIL = 80
    const LOG_KEEP = 400
    const ICON_MASK = 'dsh-rig-mask'

    const T = {
      tab: '实验室',
      panel: '插件实验室',
      guide: { title: '插件实验室', desc: '开一个真实、隔离的 DSH，看它跑起来' },
      empty: { title: '还没有实验室', desc: '建一个之后，这里会嵌进来一个真实的 DSH 进程。', action: '创建实验室', busy: '创建中…' },
      act: {
        start: '启动', stop: '停止', takeover: '接手', more: '更多操作', restart: '重启', refresh: '刷新',
        popout: '弹出到窗口', version: '切换版本', about: '关于隔离边界', destroy: '销毁', confirm: '确认销毁',
        cancel: '取消', back: '返回', hostVersion: '跟随宿主', ok: '知道了',
      },
      status: { created: '未启动', starting: '启动中', running: '运行中', stopped: '已停止', crashed: '已崩溃' },
      owner: { me: '本会话', free: '空闲', other: '会话', freeTitle: '没有会话在驾驶它' },
      lock: { on: '已锁定', off: '可介入', hint: '锁定只挡输入，不是安全边界' },
      agent: {
        on: '智能体可操作', off: '智能体未授权', noBackend: '本机没有可用浏览器后端',
        hintOn: '授权期间智能体才能点按钮、打字、截图', hintOff: '授权后智能体才能操作界面（工具只在授权期间存在）',
      },
      logs: { title: '日志', empty: '（暂无日志）' },
      view: { idle: '实验室未运行', starting: '启动中…', hint: '点「启动」后在这里看它', taken: '由别的会话驾驶 · 只读', crashed: '实验室崩了' },
      conn: { on: '已连接', off: '未连接' },
      about: '实验室是独立进程 + 独立 DSH_HOME：它崩了这边不会崩。锁定只挡输入，不是安全边界。',
      destroyWarn: '销毁会删掉实验室的目录与 profile，不能撤销。',
      loadingVersions: '读取版本清单…',
    }

    /** 状态 → 令牌名，一句 `ink()` 就能取色，不散落九个变量名。 */
    const STATE_INK = { created: 'idle', stopped: 'idle', starting: 'warn', running: 'success', crashed: 'error' }
    const ink = (status) => `var(--dsw-alias-state-${STATE_INK[status] || 'idle'}-primary)`

    // ── 2. 样式（全部走主题令牌，浅色/深色都跟宿主） ──────────────────
    const BOX = '1px solid var(--dsw-alias-border-l1)'
    const S = {
      panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: 1.5 },
      head: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px 6px', flex: 'none', minWidth: 0 },
      band: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 8px', flex: 'none', flexWrap: 'wrap' },
      body: { flex: 1, minHeight: 120, display: 'flex', padding: '0 12px' },
      foot: { display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px 10px', flex: 'none', flexWrap: 'wrap' },
      grow: { flex: 1, minWidth: 4 },
      title: { fontSize: 13, fontWeight: 600, letterSpacing: 0.2, whiteSpace: 'nowrap' },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      chip: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999, border: BOX, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', font: 'inherit' },
      chipOff: { cursor: 'not-allowed', opacity: 0.55 },
      dot: (color) => ({ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }),
      btn: { appearance: 'none', display: 'inline-flex', alignItems: 'center', gap: 5, border: BOX, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: 'pointer', font: 'inherit', whiteSpace: 'nowrap' },
      btnPrimary: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
      btnDanger: { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
      btnOff: { cursor: 'not-allowed', color: 'var(--dsw-alias-state-idle-primary)', borderColor: 'var(--dsw-alias-border-l1)' },
      pill: { display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
      viewport: { position: 'relative', flex: 1, minHeight: 140, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, overflow: 'hidden', background: 'var(--dsw-alias-bg-base)', display: 'flex' },
      frame: { width: '100%', height: '100%', border: 'none', display: 'block', background: 'transparent', flex: 1 },
      idle: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, textAlign: 'center', padding: 16, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
      shield: { position: 'absolute', inset: 0, zIndex: 2, cursor: 'not-allowed', background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 10%, transparent)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 8 },
      shieldTag: { fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-secondary)' },
      drawer: { flex: 'none', maxHeight: 140, overflow: 'auto', margin: '8px 12px 0', border: BOX, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', padding: '6px 8px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11, lineHeight: 1.45 },
      line: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-secondary)' },
      lineErr: { color: 'var(--dsw-alias-state-error-primary)' },
      note: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', padding: '2px 0' },
      error: { margin: '0 12px 8px', flex: 'none', fontSize: 12, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
    }

    // ── 3. 图标：icon.svg 的内联版（双层窗口 = 面板里套了一个真东西，绿点 = 它在跑） ──
    function LabIcon(props) {
      const size = props && props.size ? props.size : 24
      return h(
        'svg',
        { className: props && props.className, width: size, height: size, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': true },
        h('defs', null, h('mask', { id: ICON_MASK },
          h('rect', { width: 36, height: 36, fill: '#fff' }),
          h('rect', { x: 11.2, y: 13.2, width: 21.6, height: 17.6, rx: 5, fill: '#000' }))),
        h('rect', { x: 5, y: 5.5, width: 19, height: 14.5, rx: 4, stroke: '#7fb2d9', strokeWidth: 2, mask: `url(#${ICON_MASK})` }),
        h('rect', { x: 13, y: 15, width: 18, height: 14, rx: 4, stroke: '#247bbf', strokeWidth: 2 }),
        h('circle', { cx: 17.4, cy: 19.2, r: 1.7, fill: '#37b26d' }),
      )
    }

    // ── 4. 通信（唯一的 HTTP 出入口） ────────────────────────────────
    const message = (err) => (err && err.message ? err.message : String(err ?? ''))

    async function request(path, init) {
      const res = await fetch(API + path, { ...init, headers: { ...HEADERS, ...((init && init.headers) || {}) } })
      if (!res.ok) {
        let detail = ''
        try {
          detail = (await res.json()).error || ''
        } catch {
          /* 非 JSON */
        }
        throw new Error(detail || `HTTP ${res.status}`)
      }
      return res.json()
    }

    /** 手工解 SSE（EventSource 发不了自定义头）。返回时说明流结束了，不是错误。 */
    async function consumeEvents(onEvent, signal) {
      const res = await fetch(`${API}/events`, { headers: { ...HEADERS, accept: 'text/event-stream' }, signal })
      if (!res.ok || !res.body) throw new Error(`事件流 HTTP ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              onEvent(JSON.parse(line.slice(6)))
            } catch {
              /* 坏帧忽略 */
            }
          }
        }
      }
    }

    // ── 5. 页级 store：一条 SSE 常驻，面板只是订阅者 ─────────────────
    function createStore() {
      const state = { labs: [], logs: {}, connected: false, error: '', uiMode: false, ui: null, frameSig: '', frameGen: 0 }
      const listeners = new Set()
      let controller = null
      let retry = null
      let watchdog = null
      let onOpenLab = () => {}

      // 订阅方自己炸了不该拖垮事件流，所以逐个 try。
      const notify = () => { for (const fn of [...listeners]) { try { fn() } catch { /* 忽略 */ } } }
      const set = (patch) => {
        Object.assign(state, patch)
        notify()
      }
      const apply = (data) => set({
        labs: data.labs || state.labs,
        ...(data.diagnostics ? { diagnostics: data.diagnostics } : {}),
        ...(typeof data.uiMode === 'boolean' ? { uiMode: data.uiMode } : {}),
        ...(data.ui ? { ui: data.ui } : {}),
        ...(typeof data.frameSig === 'string' ? { frameSig: data.frameSig } : {}),
      })
      const pushLog = (id, entry) => {
        const list = (state.logs[id] || []).concat(entry)
        state.logs = { ...state.logs, [id]: list.length > LOG_KEEP ? list.slice(list.length - LOG_KEEP) : list }
        notify()
      }
      const refresh = () => request('/state').then(apply).catch(() => {})

      const onEvent = (event) => {
        if (event.type === 'snapshot') apply(event)
        else if (event.type === 'ui-mode') set({ uiMode: Boolean(event.enabled) })
        else if (event.type === 'url') {
          // 实验室换了地址（启动/重启）：自增一代，逼 iframe 重新走一次稳定入口拿新 token。
          set({ frameGen: state.frameGen + 1 })
          refresh()
        } else if (event.type === 'log') pushLog(event.id, event.entry)
        else if (event.type === 'open-lab') onOpenLab(event.sessionId || null)
        else if (event.type === 'status' || event.type === 'labs') refresh()
      }

      const loop = () => {
        if (!controller || controller.signal.aborted) return
        set({ connected: true })
        consumeEvents(onEvent, controller.signal)
          .then(() => {
            set({ connected: false })
            if (!controller.signal.aborted) retry = setTimeout(loop, 2_000)
          })
          .catch((err) => {
            set({ connected: false })
            if (controller.signal.aborted) return
            set({ error: `事件流断开：${message(err)}` })
            retry = setTimeout(loop, 3_000)
          })
      }

      return {
        get: () => state,
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        set,
        refresh,
        /** 补历史：事件流只推「之后」的行，面板后开时前面那些得自己拉一次环形缓冲。 */
        seedLogs(id) {
          if (id === '' || (state.logs[id] || []).length > 0) return Promise.resolve()
          return request(`/logs?id=${encodeURIComponent(id)}`)
            .then((data) => {
              const entries = (data && data.entries) || []
              if (entries.length === 0) return
              state.logs = { ...state.logs, [id]: entries.slice(-LOG_KEEP) }
              notify()
            })
            .catch(() => {})
        },
        configure(handlers) {
          if (handlers && typeof handlers.onOpenLab === 'function') onOpenLab = handlers.onOpenLab
        },
        start() {
          if (controller) return
          controller = new AbortController()
          request('/state')
            .then((data) => {
              apply(data)
              set({ error: '' })
              loop()
            })
            .catch((err) => set({ error: `拿不到实验室状态：${message(err)}（宿主可能没有 HTTP 面）` }))
          // 每 10 秒对一次状态，两个理由：
          //   1. 占用者标题会**随对话实时变**（官方 session-titles 插件按全部消息重算），而事件流不会告诉我这件事；
          //   2. 流可能安静地挂住（不报错也不送数据）—— 这一拍顺便就把「旧一拍」顶回真相，比单设看门狗简单。
          watchdog = setInterval(refresh, 10_000)
        },
        stop() {
          if (controller) controller.abort()
          controller = null
          if (retry) clearTimeout(retry)
          if (watchdog) clearInterval(watchdog)
          retry = null
          watchdog = null
        },
      }
    }

    const labStore = createStore()

    /** 订阅 store：用一个计数器触发重渲，不引入 useSyncExternalStore 的版本差异。 */
    function useLab() {
      const [, bump] = useState(0)
      useEffect(() => labStore.subscribe(() => bump((n) => n + 1)), [])
      return labStore.get()
    }

    // ── 6. 原子组件（只吃 props，不认识 ctx / 网络） ──────────────────
    function Btn({ children, onClick, disabled, tone, title }) {
      const off = Boolean(disabled)
      const style = { ...S.btn, ...(tone === 'primary' ? S.btnPrimary : {}), ...(tone === 'danger' ? S.btnDanger : {}), ...(off ? S.btnOff : {}) }
      return h('button', { type: 'button', disabled: off, title: title || children, style, onClick: off ? undefined : onClick }, children)
    }

    function Chip({ children, onClick, active, disabled, title }) {
      const off = Boolean(disabled)
      return h(
        'button',
        {
          type: 'button', disabled: off, title: title || undefined,
          style: { ...S.chip, ...(active ? S.btnPrimary : {}), ...(off ? S.chipOff : {}) },
          onClick: off ? undefined : onClick,
        },
        children,
      )
    }

    const pad2 = (n) => String(n).padStart(2, '0')

    /** 运行时长：启动至今。单独一个组件，所以每秒重渲的只有这一格。 */
    function Elapsed({ startedAt }) {
      const [, tick] = useState(0)
      useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1_000); return () => clearInterval(id) }, [])
      const t0 = Date.parse(startedAt || '')
      const seconds = Number.isFinite(t0) ? Math.max(0, Math.floor((Date.now() - t0) / 1_000)) : 0
      return h('span', null, `${pad2(Math.floor(seconds / 60))}:${pad2(seconds % 60)}`)
    }

    function StatusPill({ status, startedAt, exitAt }) {
      const crashedAgo = () => {
        const t0 = Date.parse(exitAt || '')
        if (!Number.isFinite(t0)) return T.status.crashed
        const minutes = Math.floor((Date.now() - t0) / 60_000)
        return minutes <= 0 ? '刚刚崩溃' : `${minutes} 分钟前崩溃`
      }
      return h(
        'span',
        { style: S.pill },
        h('span', { style: S.dot(ink(status)) }),
        status === 'crashed' ? crashedAgo() : T.status[status] || status,
        status === 'running' && startedAt ? h(Elapsed, { startedAt }) : null,
      )
    }

    function OwnerChip({ owner, ownerTitle, since, sessionId }) {
      if (!owner) return h('span', { style: S.chip, title: T.owner.freeTitle }, T.owner.free)
      const mine = owner === sessionId
      const t0 = Date.parse(since || '')
      const at = Number.isFinite(t0) ? `${pad2(new Date(t0).getHours())}:${pad2(new Date(t0).getMinutes())} 起` : ''
      // 标题优先（与左侧栏同一份，随对话实时变）；拿不到才退回短 id，且要跳过 `session-` 前缀
      // —— 真实 id 前 8 位人人相同（2026-11-21 真机上被智能体吐槽才发现）。
      const bare = owner.startsWith('session-') ? owner.slice(8) : owner
      const title = typeof ownerTitle === 'string' ? ownerTitle.trim() : ''
      const who = title === '' ? `${T.owner.other} ${bare.slice(0, 8)}` : title.length > 16 ? `${title.slice(0, 16)}…` : title
      return h('span', { style: { ...S.chip, ...(mine ? S.btnPrimary : {}) }, title: `${mine ? '本会话在驾驶它' : '占用者'} · ${owner}` }, mine ? T.owner.me : `${who}${at ? ` · ${at}` : ''}`)
    }

    // ── 7. 三带组件 ────────────────────────────────────────────────
    function Viewport({ frameUrl, status, locked, taken }) {
      return h(
        'div',
        { style: S.viewport },
        frameUrl
          ? h('iframe', {
              // key 绑在地址上：地址一变就强制重建 iframe，避免沿用旧文档。
              key: frameUrl,
              src: frameUrl,
              style: { ...S.frame, pointerEvents: locked ? 'none' : 'auto' },
              title: T.panel,
              'aria-hidden': locked ? 'true' : undefined,
              allow: 'clipboard-write',
            })
          : h('div', { style: S.idle },
              h('div', null, status === 'starting' ? T.view.starting : status === 'crashed' ? T.view.crashed : T.view.idle),
              h('div', null, T.view.hint)),
        locked && frameUrl ? h('div', { style: S.shield, role: 'note' }, h('span', { style: S.shieldTag }, taken ? T.view.taken : T.lock.hint)) : null,
      )
    }

    function LogDrawer({ entries }) {
      const ref = useRef(null)
      useEffect(() => {
        const el = ref.current
        if (el) el.scrollTop = el.scrollHeight
      }, [entries.length])
      if (!entries.length) return h('div', { ref, style: { ...S.drawer, color: 'var(--dsw-alias-label-secondary)' } }, T.logs.empty)
      return h('div', { ref, style: S.drawer },
        ...entries.slice(-LOG_TAIL).map((entry) => h('div', { key: entry.seq, style: { ...S.line, ...(entry.stream === 'err' ? S.lineErr : {}) } }, entry.text)))
    }

    function EmptyCard({ busy, onCreate }) {
      return h('div', { style: S.viewport },
        h('div', { style: S.idle },
          h(LabIcon, { size: 36 }),
          h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, T.empty.title),
          h('div', null, T.empty.desc),
          h(Btn, { tone: 'primary', onClick: onCreate, disabled: busy !== '' }, busy === 'create' ? T.empty.busy : T.empty.action)))
    }

    // ── 8. 容器：只做接线（状态 → 组件），不写样式细节 ─────────────
    function LabPanel(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const view = useLab()
      // 占用者标题从**客户端会话列表**拿（`useSessions` 是槽位标准 prop，左侧栏渲染的就是这份）：
      // 它覆盖全部会话、随改题实时变；宿主的 `sessions.get(id)` 只认正在跑的会话。拿不到再用 /state 的兜底。
      const byId = props && typeof props.useSessions === 'function' ? props.useSessions((state) => state.byId) : null
      // 默认**不锁**：这个面板的全部意义就是让你当手边这台机器用，锁着等于每次先点两下。
      // 锁是给「我只想看着、别手滑点到」的那种时刻准备的，chip 一键就能切。
      const [locked, setLocked] = useState(false)
      const [busy, setBusy] = useState('')
      const [nonce, setNonce] = useState(0)
      const [menu, setMenu] = useState('')
      const [versions, setVersions] = useState(null)
      const [confirming, setConfirming] = useState(false)
      const [drawer, setDrawer] = useState(false)

      const lab = view.labs.length > 0 ? view.labs[0] : null
      const entries = lab ? view.logs[lab.id] || [] : []
      const status = lab ? lab.status : 'created'
      const live = status === 'running' || status === 'starting'
      // 没有 lab、没有会话 id（拿不到身份）、或主人就是自己 → 都算「我能动」。
      const mine = !lab || !lab.ownerSessionId || sessionId === '' || lab.ownerSessionId === sessionId
      const canView = Boolean(lab && lab.url)
      // iframe 指向宿主的稳定入口而不是实验室裸地址：它每次重启都换端口与 token，
      // 直连会让面板卡在 `dsh web authentication required`（2026-11-21 撞上过一次）。
      // 没在跑时**不挂 iframe**：入口会回一张 503 的 HTML，那张页有自己的居中文字，
      // 会把面板自己的占位说明顶掉（截图里一眼能看出是两张页叠在一起）。
      const frameUrl = canView && view.frameSig ? `${API}/frame?id=${encodeURIComponent(lab.id)}&sig=${view.frameSig}&n=${nonce + view.frameGen}` : null

      const run = async (label, fn) => {
        setBusy(label)
        labStore.set({ error: '' })
        try {
          await fn()
        } catch (err) {
          labStore.set({ error: `${label}失败：${message(err)}` })
        } finally {
          setBusy('')
        }
      }
      const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body) })
      const drive = (action, extra) => run(action, () => post(`/labs/${lab.id}`, { action, sessionId, ...extra }))
      const takeover = () => run('接手', () => post(`/labs/${lab.id}/claim`, { sessionId, force: true }))
      const create = () => run('create', () => post('/labs', { sessionId }))
      const toggleAgent = (next) => run('授权', async () => {
        labStore.set({ uiMode: next })
        await post('/ui-mode', { enabled: next })
      })
      const setVersion = (version) => run('版本', () => post(`/labs/${lab.id}/version`, { version, sessionId }))
      const openVersions = () => {
        setMenu('version')
        if (!versions) request('/versions').then(setVersions).catch(() => setVersions({ cached: [] }))
      }

      // 面板后开 / 日志抽屉打开：补一次历史（事件流只推「之后」的行）。
      const labId = lab ? lab.id : ''
      useEffect(() => {
        void labStore.seedLogs(labId)
      }, [labId, drawer])

      const primary = !mine
        ? { label: T.act.takeover, tone: 'primary', run: takeover }
        : live
          ? { label: T.act.stop, run: () => drive('stop') }
          : { label: T.act.start, tone: 'primary', run: () => drive('start') }

      let menuBody = null
      if (lab && confirming) {
        menuBody = [
          h('span', { key: 'w', style: S.note }, T.destroyWarn),
          h(Btn, { key: 'y', tone: 'danger', onClick: () => { setConfirming(false); setMenu(''); void drive('destroy') } }, T.act.confirm),
          h(Btn, { key: 'n', onClick: () => setConfirming(false) }, T.act.cancel),
        ]
      } else if (lab && menu === 'more') {
        menuBody = [
          h(Btn, { key: 'r', disabled: !mine || !live || busy !== '', onClick: () => void drive('restart') }, T.act.restart),
          h(Btn, { key: 'f', disabled: !canView, onClick: () => setNonce((n) => n + 1) }, T.act.refresh),
          h(Btn, { key: 'p', disabled: !canView, onClick: () => window.open(lab.url, '_blank', 'noopener') }, T.act.popout),
          h(Btn, { key: 'v', disabled: !mine, onClick: openVersions }, T.act.version),
          h(Btn, { key: 'a', onClick: () => setMenu('about') }, T.act.about),
          h(Btn, { key: 'd', tone: 'danger', disabled: !mine || busy !== '', onClick: () => setConfirming(true) }, T.act.destroy),
        ]
      } else if (lab && menu === 'version') {
        menuBody = [
          h(Btn, { key: 'h', tone: lab.version === 'host' ? 'primary' : undefined, disabled: !mine, onClick: () => setVersion('host') }, T.act.hostVersion),
          ...(versions
            ? versions.cached.map((item) => h(Btn, { key: item.version, tone: item.version === lab.version ? 'primary' : undefined, disabled: !mine, onClick: () => setVersion(item.version) }, item.version))
            : [h('span', { key: 'loading', style: S.note }, T.loadingVersions)]),
          h(Btn, { key: 'b', onClick: () => setMenu('more') }, T.act.back),
        ]
      } else if (menu === 'about') {
        menuBody = [h('span', { key: 't', style: S.note }, T.about), h(Btn, { key: 'o', onClick: () => setMenu('') }, T.act.ok)]
      }

      return h('div', { style: S.panel },
        h('div', { style: S.head },
          h(LabIcon, { size: 16 }),
          h('span', { style: S.title }, T.panel),
          lab ? h(StatusPill, { status, startedAt: lab.startedAt, exitAt: lab.exit && lab.exit.at }) : null,
          h('span', { style: S.grow }),
          lab ? h(OwnerChip, { owner: lab.ownerSessionId, ownerTitle: (byId && byId[lab.ownerSessionId] && byId[lab.ownerSessionId].title) || lab.ownerTitle, since: lab.ownerSince, sessionId }) : null,
          h('span', { style: S.dot(view.connected ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)'), title: view.connected ? T.conn.on : T.conn.off })),
        lab
          ? h('div', { style: S.band },
              h(Btn, { tone: primary.tone, disabled: busy !== '' || (!mine && false), onClick: primary.run, title: primary.label }, primary.label),
              h(Btn, { disabled: menu === 'more' || confirming, onClick: () => setMenu(menu === 'more' ? '' : 'more'), title: T.act.more }, '⋯'),
              h('span', { style: S.grow }),
              h('span', { style: S.meta }, lab.port ? `:${lab.port}` : lab.version === 'host' ? T.act.hostVersion : lab.version))
          : null,
        menuBody ? h('div', { style: S.band }, ...menuBody) : null,
        view.error ? h('div', { style: S.error }, view.error) : null,
        h('div', { style: S.body }, lab
          ? h(Viewport, { frameUrl, status, locked: !mine || locked, taken: !mine })
          : h(EmptyCard, { busy, onCreate: create })),
        drawer && lab ? h(LogDrawer, { entries }) : null,
        h('div', { style: S.foot },
          lab ? h(Chip, { active: locked, disabled: !mine, title: T.lock.hint, onClick: () => setLocked((v) => !v) }, locked ? T.lock.on : T.lock.off) : null,
          h(Chip, {
            active: view.uiMode,
            disabled: !view.ui || view.ui.available === false,
            title: !view.ui || view.ui.available === false ? T.agent.noBackend : view.uiMode ? T.agent.hintOn : T.agent.hintOff,
            onClick: () => void toggleAgent(!view.uiMode),
          }, view.uiMode ? T.agent.on : T.agent.off),
          h('span', { style: S.grow }),
          lab ? h(Chip, { active: drawer, onClick: () => setDrawer((v) => !v) }, `${T.logs.title} · ${entries.length}`) : null))
    }

    /** tab 标题：文字 + 状态点。 */
    function LabTabTitle() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h(LabIcon, { size: 14 }),
        T.tab)
    }

    // ── 9. 注册（只接线：拿服务、注册槽位） ────────────────────────
    /** 同一个会话只自动展开一次：智能体连续调用时不反复抢焦点。 */
    const autoOpened = new Set()

    function service(ctx, key) {
      try {
        return typeof ctx?.get === 'function' ? ctx.get(key) : null
      } catch {
        return null
      }
    }

    function openLab(ctx) {
      const nav = service(ctx, 'sidebarRight')
      try {
        if (nav && typeof nav.openTab === 'function') {
          nav.openTab(TAB_KIND)
          return
        }
      } catch {
        /* 兜底 */
      }
      const layout = service(ctx, 'layout')
      try {
        if (layout && typeof layout.openRightbar === 'function') layout.openRightbar(true, false)
      } catch {
        /* 打不开不是错 */
      }
    }

    function autoOpen(ctx, sessionId) {
      const key = sessionId || 'any'
      if (autoOpened.has(key)) return
      autoOpened.add(key)
      openLab(ctx)
    }

    function collector() {
      const list = []
      return {
        add(dispose) {
          if (typeof dispose === 'function') list.push(dispose)
        },
        disposeAll() {
          while (list.length > 0) {
            try {
              list.pop()()
            } catch {
              /* 已注销 */
            }
          }
        },
      }
    }

    function registerInto(ctx) {
      const disposers = collector()
      try {
        const disposeInject = ctx.inject(['sidebarRightTabs'], (ictx) => {
          const inner = collector()
          try {
            const tabs = ictx.sidebarRightTabs
            if (!tabs || typeof tabs.register !== 'function') return inner.disposeAll
            inner.add(
              tabs.register({
                id: TAB_ID,
                kind: TAB_KIND,
                priority: 'extension',
                title: () => T.tab,
                // 开始页那张卡片的图标：内联自 icon.svg，不用 emoji。
                guide: [{ id: TAB_ID, order: GUIDE_ORDER, title: () => T.guide.title, description: () => T.guide.desc, icon: LabIcon }],
              }),
            )
            inner.add(
              ictx.slots.inject('sidebar.right.pane.tab', () =>
                ictx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, LabPanel),
              ),
            )
            inner.add(
              ictx.slots.inject('sidebar.right.pane.tab.title', () =>
                ictx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, LabTabTitle),
              ),
            )
          } catch (e) {
            console.warn('[dsh-rig] 右栏注册失败', e)
          }
          return inner.disposeAll
        })
        if (typeof disposeInject === 'function') disposers.add(disposeInject)
      } catch (e) {
        console.warn('[dsh-rig] inject(sidebarRightTabs) 不可用', e)
      }
      return () => disposers.disposeAll()
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          // 页级连接先起来：面板没打开时也要能收到 `open-lab`，否则「自动展开」无从触发。
          labStore.configure({ onOpenLab: (sessionId) => autoOpen(ctx, sessionId) })
          labStore.start()
          const dispose = registerInto(ctx)
          if (typeof ctx.effect === 'function') {
            ctx.effect(() => () => {
              dispose()
              labStore.stop()
            }, 'dsh-rig registration')
          }
        } catch (e) {
          console.warn('[dsh-rig] apply 失败', e)
        }
      },
    }
  },
})
