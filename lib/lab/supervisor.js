/**
 * dsh-rig · 进程看管（IO 层）
 *
 * 只做三件事：把它拉起来、看着它、把它收干净。拼命令在 spawn-plan.js、判隔离在 naming.js、日志在 log-buffer.js、
 * 瞬时状态在 runtime.js、端口在 port.js、探针在 probe.js、界面驱动在 ui-session.js、落盘与跨进程合并在 state-store.js。
 * 刻意不做常驻健康轮询（「卡住」和「在忙」长得一样）；不持久化 token / pid（端口固定并落盘，为了 origin 稳定）。
 */
import { mkdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DEFAULTS, STATUS } from './constants.js'
import { labPaths } from './layout.js'
import { assertIsolated, isValidLabId, nextLabId, profileNameFor } from './naming.js'
import { buildStartPlan, parseLabUrl } from './spawn-plan.js'
import { buildDiagnostics } from './diagnostics.js'
import { isPortFree, pickFreePort } from './port.js'
import { resolveCoreBin } from './core-bin.js'
import { planVersionChange } from './versioning.js'
import { copyCredentials, ensureProfile } from './provision.js'
import { attachLines, isAlive, killTree, spawnChild } from './process.js'
import { waitHealthy } from './health.js'
import { addLab, describeLab, emptyState, findLab, removeLab } from './registry.js'
import { createRuntimeTable } from './runtime.js'
import { LabStateStore } from './state-store.js'
import { isForeign } from './merge.js'
import { UiSessions } from './ui-session.js'
import { buildLabReport } from './report.js'

export class LabSupervisor {
  #root
  #hostHome
  #hostProfile
  #execPath
  #isElectron
  #env
  #log
  #config
  #store
  #hostId
  #state = emptyState()
  #rt
  #ui
  #uiMode = false
  #disposed = false

  constructor(opts) {
    this.#root = opts.root
    this.#hostHome = opts.hostHome
    this.#hostProfile = opts.hostProfile || 'web'
    this.#execPath = opts.execPath
    this.#isElectron = Boolean(opts.isElectron)
    this.#env = opts.env || {}
    this.#log = typeof opts.log === 'function' ? opts.log : () => {}
    this.#config = { ...DEFAULTS, ...(opts.config || {}) }
    this.#store = new LabStateStore({ file: labPaths(this.#root, null).labsFile, log: (line) => this.#log(line) })
    this.#hostId = randomBytes(6).toString('hex')
    this.#rt = createRuntimeTable({
      logRingLines: this.#config.logRingLines,
      log: (line) => this.#log(line),
      onEvent: opts.onEvent,
    })
    const backendPreference = this.#config.uiBackend || this.#env.DSH_RIG_UI_BACKEND || 'auto'
    this.#ui = new UiSessions({ log: (line) => this.#log(line), preference: backendPreference })
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  subscribe(fn) {
    return this.#rt.subscribe(fn)
  }

  /** 广播「看这个实验室」：智能体首次驱动时，面板据此自动展开右栏（不抢焦点，每个会话只展开一次）。 */
  announce(id, sessionId) { this.#rt.emit({ type: 'open-lab', id, sessionId: sessionId || null }) }

  // ── 持久状态（落盘与跨进程合并都在 state-store 里） ──────────────────
  async load() {
    await mkdir(this.#root, { recursive: true })
    const { state, problem } = await this.#store.load()
    if (problem) this.#log(`[dsh-rig] labs.json 读不出（${problem}），按空状态处理`)
    this.#state = state
    return state
  }

  /** 落盘：锁 → 读盘 → 合并 → 写。别的宿主进程管的实验室不会被这次写抹掉。 */
  async #save() {
    this.#state = await this.#store.save(this.#state)
  }

  // ── 读取 ────────────────────────────────────────────────────────────
  list() {
    return this.#state.labs.map((lab) => {
      const rt = this.#rt.get(lab.id)
      // 「别人的」只认运行时事实：记录里的 pid 还活着，且不是本进程正在管的那个。
      // 以前认 hostId（每进程随机）—— 宿主一重启就把自己的实验室全判成外人（2026-11-24 锁死事故）。
      return { ...describeLab(lab, rt), foreign: isForeign(lab, { ownedPid: rt?.pid ?? null, alive: isAlive }) }
    })
  }

  get(id) {
    const lab = findLab(this.#state, id)
    return lab ? describeLab(lab, this.#rt.get(id)) : null
  }

  logs(id, since = 0) {
    return this.#rt.logs(id, since)
  }

  /** 体检：声明 / 补丁 / 运行时 / 启动日志事实 / 工作区，五块证据各自独立。 */
  async report(id) {
    const lab = findLab(this.#state, id)
    if (!lab) throw new Error(`没有实验室 ${id}`)
    return buildLabReport({ lab, runtime: this.#rt.get(id), labPaths: labPaths(this.#root, id), logEntries: this.#rt.logs(id, 0).entries })
  }

  /** 对实验室记录做一次纯变更并落盘 —— 占用声明这类小改写走这里，别另开一套写盘。 */
  async mutate(id, fn) {
    const lab = findLab(this.#state, id)
    if (!lab) throw new Error(`没有实验室 ${id}`)
    const result = fn(lab)
    await this.#save()
    this.#rt.emit({ type: 'labs', at: new Date().toISOString() })
    return result
  }

  diagnostics() {
    const { startTimeoutMs, logRingLines, maxLabs } = this.#config
    const sample = this.#state.labs[0]
    const sampleLabHome = sample ? labPaths(this.#root, sample.id).home : null
    return buildDiagnostics({ labRoot: this.#root, hostHome: this.#hostHome, hostProfile: this.#hostProfile, isElectron: this.#isElectron, env: this.#env, limits: { startTimeoutMs, logRingLines, maxLabs }, sampleLabHome })
  }

  // ── 界面驱动（让智能体像人一样操作实验室） ──────────────────────────
  uiAvailable() {
    return this.#ui.available()
  }

  /** 智能体能否操作界面：默认关，随宿主重启复位（避免「一次授权永久生效」）。 */
  uiMode() {
    return this.#uiMode
  }

  setUiMode(enabled) {
    const next = Boolean(enabled)
    if (next === this.#uiMode) return next
    this.#uiMode = next
    this.#rt.emit({ type: 'ui-mode', enabled: next })
    return next
  }

  /** 看 / 拍 / 点 / 打 / 跑任务。只驱动界面，不碰实验室内部服务 —— 所以按文字找元素、找不到报候选。 */
  async ui(id, action, args = {}) {
    if (!this.#uiMode) throw new Error('智能体操作界面未开启：先在面板里打开「允许智能体操作」')
    const lab = findLab(this.#state, id)
    if (!lab) throw new Error(`没有实验室 ${id}`)
    const rt = this.#rt.get(id)
    if (!rt || !rt.url) throw new Error('实验室没在运行：先 start')
    return this.#ui.call(id, rt.url, labPaths(this.#root, id).dir, action, args)
  }

  // ── 生命周期 ────────────────────────────────────────────────────────
  async create({ name, version = 'host' } = {}) {
    if (this.#state.labs.length >= this.#config.maxLabs) {
      throw new Error(`最多 ${this.#config.maxLabs} 个实验室；先销毁一个`)
    }
    // 先把别的宿主进程写进去的实验室合进来，再挑 id —— 否则两边可能各建一个 lab1。
    this.#state = await this.#store.refresh(this.#state)
    const id = nextLabId(this.#state.labs.map((lab) => lab.id))
    if (!id) throw new Error('没有可用 id')

    const paths = labPaths(this.#root, id)
    const iso = assertIsolated(paths.home, this.#hostHome)
    if (!iso.ok) throw new Error(`拒绝创建：${iso.reason}`)

    await mkdir(paths.home, { recursive: true })
    await mkdir(paths.workspace, { recursive: true })
    await mkdir(paths.tasks, { recursive: true })

    const lab = {
      id,
      name: typeof name === 'string' && name.trim() !== '' ? name.trim().slice(0, 40) : `实验台 ${id}`,
      version: typeof version === 'string' ? version : 'host',
      profile: profileNameFor(id),
      port: await pickFreePort(this.#config.basePort + this.#state.labs.length), // 固定端口 = 固定 origin（见 port.js）
      hostId: this.#hostId,
      createdAt: new Date().toISOString(),
    }
    this.#rt.of(id)

    await this.#provision(lab)
    if (this.#config.copyCredentials !== false) {
      const ok = await copyCredentials({ fromHome: this.#hostHome, toHome: paths.home })
      this.#rt.pushLog(
        id,
        'rig',
        ok ? '已复制宿主凭据到实验室（可在配置里关掉）' : '宿主凭据不存在或复制失败：实验室里的智能体将没有可用模型',
      )
    }

    addLab(this.#state, lab)
    await this.#save()
    this.#rt.pushLog(id, 'rig', `实验室已创建：${lab.name}（profile=${lab.profile}）`)
    this.#rt.emit({ type: 'labs', at: new Date().toISOString() })
    return this.get(id)
  }

  /**
   * 一次性准备：profile（不在就补建）与凭据。
   *
   * 实现搬到 `provision.js` 了 —— 这个类已经贴着 420 行上限，而准备动作与生命周期无关。
   * 留这个薄壳是为了让 create / start 两处共用同一套日志与路径。
   */
  async #provision(lab) {
    const paths = labPaths(this.#root, lab.id)
    return ensureProfile({
      lab,
      home: paths.home,
      workspace: paths.workspace,
      execPath: this.#execPath,
      isElectron: this.#isElectron,
      version: lab.version,
      root: this.#root,
      env: this.#env,
      log: (stream, line) => {
        this.#rt.pushLog(lab.id, stream, line)
      },
    })
  }

  /**
   * 把「这条记录现在被谁跑着」写进盘。
   *
   * 跨进程判定「是不是别人在跑」只认这个字段（见 merge.isForeign）：
   * pid 存活 = 真有人在跑；pid 为空 = 没人跑，谁都可以接管。
   * 落盘失败只记日志，不让一次写盘失败把启动流程带垮。
   */
  async #stampPid(id, pid) {
    const lab = findLab(this.#state, id)
    if (!lab) return
    lab.pid = Number.isInteger(pid) && pid > 0 ? pid : null
    lab.pidStartedAt = lab.pid ? new Date().toISOString() : null
    try {
      await this.#save()
    } catch (err) {
      this.#log(`[dsh-rig] pid 落盘失败：${err?.message ?? err}`)
    }
  }

  async start(id) {
    const lab = findLab(this.#state, id)
    if (!lab) throw new Error(`没有实验室 ${id}`)
    const rt = this.#rt.of(id)
    if (rt.status === STATUS.starting || rt.status === STATUS.running) return this.get(id)

    const paths = labPaths(this.#root, id)
    const iso = assertIsolated(paths.home, this.#hostHome)
    if (!iso.ok) throw new Error(`拒绝启动：${iso.reason}`)

    await mkdir(paths.home, { recursive: true })
    await mkdir(paths.workspace, { recursive: true })

    // 0.1.6：起之前验一次 profile。lab1 就是栽在这儿 —— 创建时静默失败，之后每次启动都报
    // `profile "rig-lab1" does not exist`。正常情况这里只是 stat 一次目录；缺失时才补建（几十秒）。
    const provision = await this.#provision(lab)
    if (!provision.ok) {
      throw new Error(`实验室的 profile 建不出来（${provision.reason}）：${lab.profile}`)
    }

    if (!lab.port || !(await isPortFree(lab.port))) {
      lab.port = await pickFreePort(this.#config.basePort)
      await this.#save()
    }

    const plan = buildStartPlan({
      execPath: this.#execPath,
      isElectron: this.#isElectron,
      coreBin: await resolveCoreBin({ version: lab.version, root: this.#root, env: this.#env }),
      profile: lab.profile,
      cwd: paths.workspace,
      home: paths.home,
      env: this.#env,
      port: lab.port || 0,
    })

    rt.exit = null
    rt.port = null
    rt.url = null
    rt.token = null
    this.#rt.setStatus(id, STATUS.starting, { startedAt: new Date().toISOString() })
    this.#rt.pushLog(id, 'rig', `启动：${plan.command} ${plan.args.join(' ')}`)
    this.#rt.pushLog(id, 'rig', `DSH_HOME=${plan.env.DSH_HOME}  cwd=${plan.cwd}`)

    let child
    try {
      child = spawnChild(plan)
    } catch (err) {
      this.#rt.setStatus(id, STATUS.crashed, { exit: { code: null, at: new Date().toISOString(), error: String(err) } })
      throw err
    }
    rt.child = child
    rt.pid = child.pid ?? null
    await this.#stampPid(id, rt.pid)

    // 注意签名：attachLines 回调是 (stream, line)，不是柯里化 —— 2026-11-21 错配导致实验室输出全被吞。
    attachLines(child, (stream, line) => {
      if (!this.#rt.pushLog(id, stream, line)) return
      const parsed = parseLabUrl(line)
      if (parsed) {
        rt.port = parsed.port
        rt.token = parsed.token
        rt.url = parsed.url
        this.#rt.emit({ type: 'url', id, url: parsed.url, port: parsed.port })
      }
    })

    child.on('error', (err) => {
      this.#rt.pushLog(id, 'rig', `子进程错误：${err?.message ?? err}`)
      this.#rt.setStatus(id, STATUS.crashed, { exit: { code: null, at: new Date().toISOString(), error: String(err) } })
    })

    child.on('exit', (code, signal) => {
      rt.child = null
      rt.pid = null
      void this.#stampPid(id, null)
      const wasLive = rt.status === STATUS.starting || rt.status === STATUS.running
      const exit = { code: code ?? null, signal: signal ?? null, at: new Date().toISOString() }
      this.#rt.pushLog(id, 'rig', `实验室退出：code=${exit.code ?? 'null'} signal=${exit.signal ?? 'null'}`)
      if (wasLive && code !== 0) this.#rt.setStatus(id, STATUS.crashed, { exit })
      else if (wasLive) this.#rt.setStatus(id, STATUS.stopped, { exit })
      rt.url = null
      rt.token = null
      rt.port = null
      this.#ui.close(id)
    })

    void waitHealthy({
      id,
      rt,
      deadline: Date.now() + this.#config.startTimeoutMs,
      config: this.#config,
      setStatus: (labId, status, extra) => this.#rt.setStatus(labId, status, extra),
      pushLog: (labId, stream, line) => this.#rt.pushLog(labId, stream, line),
      stop: (labId, opts) => this.stop(labId, opts),
      isDisposed: () => this.#disposed,
    })
    return this.get(id)
  }

  async stop(id, opts = {}) {
    const rt = this.#rt.get(id)
    if (!rt) return this.get(id)
    const pid = rt.pid
    if (pid) {
      this.#rt.pushLog(id, 'rig', `停止 pid=${pid}…`)
      try {
        await killTree(pid)
      } catch (err) {
        this.#rt.pushLog(id, 'rig', `停止命令失败（进程可能已退出）：${err?.message ?? err}`)
      }
      const until = Date.now() + 10_000
      while (rt.pid && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
    }
    if (opts.asCrash) this.#rt.setStatus(id, STATUS.crashed)
    else if (rt.status !== STATUS.crashed) this.#rt.setStatus(id, STATUS.stopped)
    rt.url = null
    rt.token = null
    rt.port = null
    this.#ui.close(id)
    await this.#stampPid(id, null)
    return this.get(id)
  }

  /** 切版本：只改声明并落盘；真正生效要重启（面板/工具会提示）。 */
  async setVersion(id, version) {
    const lab = findLab(this.#state, id)
    if (!lab) throw new Error(`没有实验室 ${id}`)
    const next = await planVersionChange({ lab, version, root: this.#root, env: this.#env })
    await this.#save()
    this.#rt.emit({ type: 'labs', at: new Date().toISOString() })
    this.#rt.pushLog(id, 'rig', `版本已切换为 ${next}（重启后生效）`)
    return this.get(id)
  }

  async restart(id) {
    await this.stop(id)
    return this.start(id)
  }

  async destroy(id) {
    if (!isValidLabId(id)) throw new Error(`非法 id：${id}`)
    await this.stop(id)
    const paths = labPaths(this.#root, id)
    if (!paths.dir.startsWith(join(this.#root, 'labs'))) throw new Error('拒绝删除：路径越界')
    try {
      await rm(paths.dir, { recursive: true, force: true })
    } catch (err) {
      this.#rt.pushLog(id, 'rig', `删目录失败：${err?.message ?? err}`)
    }
    this.#ui.close(id)
    removeLab(this.#state, id)
    this.#rt.drop(id)
    await this.#save()
    this.#rt.emit({ type: 'labs', at: new Date().toISOString() })
    return { id, destroyed: true }
  }

  /** 插件卸载 / 宿主退出：把还活着的实验室全停掉，不留孤儿。 */
  async disposeAll() {
    this.#disposed = true
    for (const id of this.#rt.liveIds()) {
      try {
        await this.stop(id)
      } catch {
        /* 收工阶段不抛 */
      }
    }
    await this.#ui.closeAll()
    this.#rt.dispose()
  }
}
