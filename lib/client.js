/**
 * dsh-rig · client half — 右栏「插件实验室」面板
 *
 * ⚠️ 这个文件是**一个 ModuleLoader bundle**：协议上没法拆成多文件（factory 只能 require
 * 宿主导出的模块，不能 require 本包自己的文件）。所以「组件化」靠文件内的分区保证，
 * 分区顺序固定：常量 → 样式 → 通信 → hook → 原子组件 → 容器 → 注册。
 * 结构守卫（test/structure.test.mjs）盯着它的行长上限与 API 前缀对拍。
 *
 * 承载面走 DSH 官方右栏注册表：`sidebarRightTabs.register` 定义 tab 类型 + guide 卡片，
 * 正文/标题注册进键控槽，另在会话头部加一个入口按钮。
 *
 * 数据面走宿主 webServer 的 `/dsh-rig/api`：事件流用 fetch 手工解 SSE（EventSource 发不了
 * 自定义头），命令走 POST。iframe 是跨源的，所以「锁定」只能挡输入，不能碰它内部状态。
 */
window.__ModuleLoader__.load({
  id: 'dsh-rig',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    // ── 1. 常量（一个名字只在这里出现一次） ────────────────────────────
    const TAB_ID = 'dsh-rig'
    const TAB_KIND = 'dsh-rig:lab'
    const GUIDE_ORDER = 45
    const HEADER_ACTION_ORDER = 32
    /** 与 host 半 `lib/lab/constants.js` 的 API_PREFIX 必须一致，由结构守卫对拍。 */
    const API = '/dsh-rig/api'
    const HEADERS = { 'x-dsh-rig': '1' }
    const LOG_TAIL = 80
    const LOG_KEEP = 400

    const T = {
      tab: '实验室',
      panelTitle: '插件实验室',
      guideTitle: '插件实验室',
      guideDescription: '开一个真实、隔离的 DSH，看它跑起来',
      headerAction: '插件实验室',
      emptyTitle: '还没有实验室',
      emptyDesc: '建一个之后，这里会嵌进来一个真实的 DSH 进程。',
      create: '创建实验室',
      creating: '创建中…',
      actions: { start: '启动', restart: '重启', refresh: '刷新', stop: '停止', destroy: '销毁', popout: '弹出' },
      mode: { lock: '锁定', unlock: '可介入' },
      modeHint: { lock: '仅智能体可操作', unlock: '你可以直接上手' },
      agent: {
        label: '智能体操作界面',
        on: '已授权',
        off: '未授权',
        hintOff: '授权后智能体才能点按钮、打字、截图（工具只在授权期间存在）',
        hintOn: '智能体现在可以操作这个实验室的界面',
        noBackend: '本机没有可用浏览器后端（装 playwright 后可用）',
      },
      lockBadge: '已锁定 · 点「可介入」解锁',
      viewport: { idle: '实验室未运行', hint: '点「启动」后在这里看它', starting: '启动中…' },
      logs: { title: '日志', empty: '（暂无日志）' },
      conn: { on: '已连接', off: '未连接' },
      status: { created: '未启动', starting: '启动中', running: '运行中', stopped: '已停止', crashed: '已崩溃' },
      hint: '实验室是独立进程：它崩了这边不会崩。锁定只挡输入，不是安全边界。',
      hostVersion: '跟随宿主',
    }

    const COLOR = {
      created: 'var(--dsw-alias-state-idle-primary)',
      stopped: 'var(--dsw-alias-state-idle-primary)',
      starting: 'var(--dsw-alias-state-warn-primary)',
      running: 'var(--dsw-alias-state-success-primary)',
      crashed: 'var(--dsw-alias-state-error-primary)',
    }

    // ── 2. 样式（全部走主题令牌，浅色/深色都跟宿主） ──────────────────
    const S = {
      panel: {
        display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 12px 14px',
        height: '100%', minHeight: 0, boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: 1.5,
      },
      row: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none', minWidth: 0 },
      title: { fontSize: 13, fontWeight: 600, letterSpacing: 0.2, whiteSpace: 'nowrap' },
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
        fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap',
      },
      dot: (color) => ({ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }),
      spacer: { flex: 1 },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      controls: { display: 'flex', flexWrap: 'wrap', gap: 6, flex: 'none' },
      btn: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)', borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: 'pointer', font: 'inherit',
      },
      btnPrimary: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
      btnDanger: { color: 'var(--dsw-alias-state-error-primary)' },
      btnOff: { cursor: 'not-allowed', color: 'var(--dsw-alias-state-idle-primary)' },
      seg: { display: 'flex', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, overflow: 'hidden', flex: 'none' },
      segItem: (active) => ({
        padding: '4px 10px', fontSize: 12, cursor: 'pointer', font: 'inherit', appearance: 'none', border: 'none',
        background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
        color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
      }),
      viewportWrap: {
        position: 'relative', flex: 1, minHeight: 160, border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10, overflow: 'hidden', background: 'var(--dsw-alias-bg-base)',
      },
      viewportIdle: {
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 6, textAlign: 'center', padding: 16,
        color: 'var(--dsw-alias-label-secondary)', fontSize: 12,
      },
      frame: { width: '100%', height: '100%', border: 'none', display: 'block', background: 'transparent' },
      lockShield: {
        position: 'absolute', inset: 0, zIndex: 2, cursor: 'not-allowed',
        background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 8%, transparent)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 8,
      },
      lockBadge: {
        fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-secondary)',
      },
      logBox: {
        flex: 'none', maxHeight: 150, overflow: 'auto', border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8, background: 'var(--dsw-alias-bg-layer-1)', padding: '6px 8px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11, lineHeight: 1.45,
      },
      logLine: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-secondary)' },
      logErr: { color: 'var(--dsw-alias-state-error-primary)' },
      errorBar: {
        flex: 'none', fontSize: 12, padding: '6px 8px', borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)',
      },
      hint: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', flex: 'none' },
      headerButton: {
        appearance: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', borderRadius: 999,
        padding: '3px 10px', fontSize: 12, cursor: 'pointer', font: 'inherit', flex: 'none',
      },
    }

    // ── 3. 通信（唯一的 HTTP 出入口） ────────────────────────────────
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

    /** 手工解 SSE。返回时说明流结束了（不是错误）。 */
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

    // ── 4. hook：把事件流收敛成一份视图状态 ──────────────────────────
    function useLabState() {
      const [labs, setLabs] = useState([])
      const [diagnostics, setDiagnostics] = useState(null)
      const [logs, setLogs] = useState({})
      const [connected, setConnected] = useState(false)
      const [error, setError] = useState('')
      const [uiMode, setUiMode] = useState(false)
      const [ui, setUi] = useState(null)

      useEffect(() => {
        const controller = new AbortController()
        let retry = null

        const pushLog = (id, entry) =>
          setLogs((prev) => {
            const list = (prev[id] || []).concat(entry)
            return { ...prev, [id]: list.length > LOG_KEEP ? list.slice(list.length - LOG_KEEP) : list }
          })

        const applyState = (data) => {
          setLabs(data.labs || [])
          if (data.diagnostics) setDiagnostics(data.diagnostics)
          if (typeof data.uiMode === 'boolean') setUiMode(data.uiMode)
          if (data.ui) setUi(data.ui)
        }

        const refresh = () => request('/state').then(applyState).catch(() => {})

        const applyEvent = (event) => {
          if (event.type === 'snapshot') {
            setLabs(event.labs || [])
            if (event.diagnostics) setDiagnostics(event.diagnostics)
            if (typeof event.uiMode === 'boolean') setUiMode(event.uiMode)
            if (event.ui) setUi(event.ui)
          } else if (event.type === 'ui-mode') {
            setUiMode(Boolean(event.enabled))
          } else if (event.type === 'log') {
            pushLog(event.id, event.entry)
          } else if (event.type === 'status' || event.type === 'url' || event.type === 'labs') {
            refresh()
          }
        }

        const loop = () => {
          if (controller.signal.aborted) return
          setConnected(true)
          consumeEvents(applyEvent, controller.signal)
            .then(() => {
              setConnected(false)
              if (!controller.signal.aborted) retry = setTimeout(loop, 2_000)
            })
            .catch((err) => {
              setConnected(false)
              if (controller.signal.aborted) return
              setError(`事件流断开：${err && err.message ? err.message : err}`)
              retry = setTimeout(loop, 3_000)
            })
        }

        request('/state')
          .then((data) => {
            applyState(data)
            setError('')
            loop()
          })
          .catch((err) => setError(`拿不到实验室状态：${err && err.message ? err.message : err}（宿主可能没有 HTTP 面）`))

        return () => {
          controller.abort()
          if (retry) clearTimeout(retry)
        }
      }, [])

      return { labs, diagnostics, logs, connected, error, setError, uiMode, setUiMode, ui }
    }

    // ── 5. 原子组件（只吃 props，不认识 ctx / 网络） ──────────────────
    function StatusPill({ label, color }) {
      return h('span', { style: S.pill }, h('span', { style: S.dot(color) }), label)
    }

    function Btn({ children, onClick, disabled, tone, title }) {
      const off = Boolean(disabled)
      const style = { ...S.btn, ...(tone === 'primary' ? S.btnPrimary : {}), ...(tone === 'danger' ? S.btnDanger : {}), ...(off ? S.btnOff : {}) }
      return h('button', { type: 'button', disabled: off, title: title || children, style, onClick: off ? undefined : onClick }, children)
    }

    function MetaRow({ left, right }) {
      return h('div', { style: S.row }, h('span', { style: S.meta }, left), h('span', { style: S.spacer }), right ? h('span', { style: S.meta }, right) : null)
    }

    // ── 6. 业务组件（每个只负责一件事） ──────────────────────────────
    function LabModeSwitch({ locked, onChange }) {
      return h(
        'div',
        { style: S.row },
        h(
          'div',
          { style: S.seg },
          h('button', { type: 'button', style: S.segItem(locked), onClick: () => onChange(true) }, T.mode.lock),
          h('button', { type: 'button', style: S.segItem(!locked), onClick: () => onChange(false) }, T.mode.unlock),
        ),
        h('span', { style: S.meta }, locked ? T.modeHint.lock : T.modeHint.unlock),
      )
    }

    /**
     * 「允许智能体操作界面」开关。
     * 它不是一个纯 UI 状态：打开/关闭会让宿主**注册/注销** `lab_ui` 工具。
     * 所以文案要说清代价 —— 授权期间智能体才有点击与打字的工具。
     */
    function LabAgentSwitch({ enabled, backend, available, onChange }) {
      const usable = available !== false
      return h(
        'div',
        { style: S.row },
        h(
          'button',
          {
            type: 'button',
            disabled: !usable,
            style: { ...S.btn, ...(enabled ? S.btnPrimary : {}), ...(usable ? {} : S.btnOff) },
            title: usable ? '' : T.agent.noBackend,
            onClick: () => usable && onChange(!enabled),
          },
          `${T.agent.label}：${enabled ? T.agent.on : T.agent.off}`,
        ),
        h(
          'span',
          { style: S.meta },
          usable ? (enabled ? T.agent.hintOn : T.agent.hintOff) : T.agent.noBackend,
        ),
      )
    }

    function LabControls({ lab, busy, live, onAction, onRefresh, onPopout }) {
      const any = busy !== ''
      return h(
        'div',
        { style: S.controls },
        h(Btn, { tone: 'primary', disabled: any || !lab || live, onClick: () => onAction('start') }, T.actions.start),
        h(Btn, { disabled: any || !live, onClick: () => onAction('restart') }, T.actions.restart),
        h(Btn, { disabled: !lab || !lab.url, onClick: onRefresh }, T.actions.refresh),
        h(Btn, { disabled: !lab || !lab.url, onClick: onPopout }, T.actions.popout),
        h(Btn, { disabled: any || !live, onClick: () => onAction('stop') }, T.actions.stop),
        h(Btn, { tone: 'danger', disabled: any || live, onClick: () => onAction('destroy') }, T.actions.destroy),
      )
    }

    function LabViewport({ lab, locked, frameUrl }) {
      const status = lab ? lab.status : 'created'
      return h(
        'div',
        { style: S.viewportWrap },
        frameUrl
          ? h('iframe', {
              src: frameUrl,
              style: { ...S.frame, pointerEvents: locked ? 'none' : 'auto' },
              title: T.panelTitle,
              allow: 'clipboard-write',
            })
          : h(
              'div',
              { style: S.viewportIdle },
              h('div', null, status === 'starting' ? T.viewport.starting : T.viewport.idle),
              h('div', null, T.viewport.hint),
            ),
        locked && frameUrl ? h('div', { style: S.lockShield }, h('span', { style: S.lockBadge }, T.lockBadge)) : null,
      )
    }

    function LabLogPanel({ entries }) {
      const ref = useRef(null)
      useEffect(() => {
        const el = ref.current
        if (el) el.scrollTop = el.scrollHeight
      }, [entries.length])
      if (!entries.length) return h('div', { style: { ...S.logBox, color: 'var(--dsw-alias-label-secondary)' } }, T.logs.empty)
      return h(
        'div',
        { style: S.logBox, ref },
        ...entries.slice(-LOG_TAIL).map((entry) =>
          h('div', { key: entry.seq, style: { ...S.logLine, ...(entry.stream === 'err' ? S.logErr : {}) } }, entry.text),
        ),
      )
    }

    function LabEmpty({ busy, onCreate }) {
      return h(
        'div',
        { style: { ...S.viewportWrap, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        h(
          'div',
          { style: S.viewportIdle },
          h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, T.emptyTitle),
          h('div', null, T.emptyDesc),
          h(Btn, { tone: 'primary', onClick: onCreate, disabled: busy !== '' }, busy === 'create' ? T.creating : T.create),
        ),
      )
    }

    // ── 7. 容器：只做接线（状态 → 组件），不写样式细节 ─────────────
    function LabPanel() {
      const { labs, logs, connected, error, setError, uiMode, setUiMode, ui } = useLabState()
      const [locked, setLocked] = useState(true)
      const [busy, setBusy] = useState('')
      const [nonce, setNonce] = useState(0)

      const lab = labs.length > 0 ? labs[0] : null
      const entries = lab ? logs[lab.id] || [] : []
      const status = lab ? lab.status : 'created'
      const live = status === 'running' || status === 'starting'
      const frameUrl = lab && lab.url ? `${lab.url}${lab.url.indexOf('?') >= 0 ? '&' : '?'}rig=${nonce}` : null

      const run = useCallback(
        async (label, fn) => {
          setBusy(label)
          setError('')
          try {
            await fn()
          } catch (err) {
            setError(`${label}失败：${err && err.message ? err.message : err}`)
          } finally {
            setBusy('')
          }
        },
        [setError],
      )

      const createLab = () => run('create', () => request('/labs', { method: 'POST', body: JSON.stringify({}) }))
      const toggleAgent = (next) =>
        run('授权', async () => {
          setUiMode(next)
          await request('/ui-mode', { method: 'POST', body: JSON.stringify({ enabled: next }) })
        })
      const onAction = (action) => run(action, () => request(`/labs/${lab.id}`, { method: 'POST', body: JSON.stringify({ action }) }))

      return h(
        'div',
        { style: S.panel },
        h(
          'div',
          { style: S.row },
          h('span', { style: S.title }, T.panelTitle),
          lab ? h(StatusPill, { label: T.status[status] || status, color: COLOR[status] || COLOR.created }) : null,
          h('span', { style: S.spacer }),
          h('span', { style: S.meta }, connected ? T.conn.on : T.conn.off),
        ),
        lab ? h(MetaRow, { left: `${lab.version === 'host' ? T.hostVersion : lab.version} · ${lab.id}`, right: lab.port ? `:${lab.port}` : null }) : null,
        error ? h('div', { style: S.errorBar }, error) : null,
        !lab
          ? h(LabEmpty, { busy, onCreate: createLab })
          : h(
              React.Fragment,
              null,
              h(LabControls, {
                lab,
                busy,
                live,
                onAction,
                onRefresh: () => setNonce((n) => n + 1),
                onPopout: () => lab.url && window.open(lab.url, '_blank', 'noopener'),
              }),
              h(LabModeSwitch, { locked, onChange: setLocked }),
              h(LabAgentSwitch, {
                enabled: uiMode,
                backend: ui && ui.backend,
                available: ui ? ui.available : null,
                onChange: toggleAgent,
              }),
              h(LabViewport, { lab, locked, frameUrl }),
              h(MetaRow, { left: `${T.logs.title}（${entries.length}）` }),
              h(LabLogPanel, { entries }),
            ),
        h('div', { style: S.hint }, T.hint),
      )
    }

    /** tab 标题：文字 + 状态点。 */
    function LabTabTitle() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { style: S.dot('var(--dsw-alias-state-idle-primary)') }),
        T.tab,
      )
    }

    // ── 8. 注册（只接线：拿服务、注册槽位） ─────────────────────────
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
                guide: [{ id: TAB_ID, order: GUIDE_ORDER, title: () => T.guideTitle, description: () => T.guideDescription }],
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

      try {
        const slots = service(ctx, 'slots')
        if (slots && typeof slots.inject === 'function') {
          disposers.add(
            slots.inject('conversation.session.header.actions', () =>
              slots.register(
                { name: 'conversation.session.header.actions', id: TAB_ID, order: HEADER_ACTION_ORDER, label: T.headerAction },
                function HeaderButton() {
                  return h(
                    'button',
                    { type: 'button', style: S.headerButton, title: T.headerAction, onClick: () => openLab(ctx) },
                    h('span', { 'aria-hidden': true }, '🧪'),
                    h('span', null, T.headerAction),
                  )
                },
              ),
            ),
          )
        }
      } catch (e) {
        console.warn('[dsh-rig] 头部入口注册失败', e)
      }

      return () => disposers.disposeAll()
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          const dispose = registerInto(ctx)
          if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-rig registration')
        } catch (e) {
          console.warn('[dsh-rig] apply 失败', e)
        }
      },
    }
  },
})
