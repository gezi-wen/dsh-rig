/**
 * dsh-rig · 进程看管（IO 层 · 唯一写盘点）
 *
 * 只做三件事：**把实验室拉起来、看着它、把它收干净**。
 * 拼命令行在 `spawn-plan.js`（纯）、判隔离在 `naming.js`（纯）、日志缓冲在 `log-buffer.js`（纯）、
 * 瞬时状态在 `runtime.js`（纯）、探针在 `probe.js`、一次性命令在 `seed.js`、界面驱动在 `ui-session.js`。
 * 这里只负责把它们串起来，并保证**所有落盘与杀进程都只发生在本文件**。
 *
 * 刻意不做的两件事：
 *   - 不做常驻健康轮询：只在启动阶段探到活，之后靠子进程 `exit` 判死。
 *     常驻轮询会让「卡住」和「在忙」长得一样，反而更难判断。
 *   - 不持久化端口/token/pid：端口每次由系统分配、token 每次现生成。
 */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULTS, STATUS } from './constants.js'
import { labPaths } from './layout.js'
import { assertIsolated, isValidLabId, nextLabId, profileNameFor } from './naming.js'
import { buildSeedPlan, buildStartPlan, parseLabUrl } from './spawn-plan.js'
import { buildDiagnostics } from './diagnostics.js'
import { resolveCoreBin } from './core-bin.js'
import { copyCredentials, runOnce } from './seed.js'
import { attachLines, killTree, spawnChild } from './process.js'
import { probeOnce } from './probe.js'
import { addLab, describeLab, emptyState, findLab, parseState, removeLab, serializeState } from './registry.js'
import { createRuntimeTable } from './runtime.js'
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
    this.#rt = createRuntimeTable({
      logRingLines: this.#config.logRingLines,
      log: (line) => this.#log(line),
      onEvent: opts.onEvent,
    })
    // 后端偏好：配置优先，其次环境变量（调试时一条 export 就能强制走 CDP）。
    const backendPreference = this.#config.uiBackend || this.#env.DSH_RIG_UI_BACKEND || 'auto'
    this.#ui = new UiSessions({ log: (line) => this.#log(line), preference: backendPreference })
  }

  // ── 事件 ────────────────────────────────────────────────────────────
  subscribe(fn) {
    return this.#rt.subscribe(fn)
  }

  // ── 持久状态 ────────────────────────────────────────────────────────
  async load() {
    const { labsFile, root } = labPaths(this.#root, null)
    await mkdir(root, { recursive: true })
    let text = ''
    try {
      text = await readFile(labsFile, 'utf8')
    } catch {
      this.#state = emptyState()
      return this.#state
    }
    const { state, problem } = parseState(text)
    if (problem) this.#log(`[dsh-rig] labs.json 读不出（${problem}），按空状态处理`)
    this.#state = state
    return state
  }

  async #save() {
    const { labsFile } = labPaths(this.#root, null)
    const tmp = `${labsFile}.tmp`
    await writeFile(tmp, serializeState(this.#state), 'utf8')
    await rename(tmp, labsFile)
  }

  // ── 读取 ────────────────────────────────────────────────────────────
  list() {
    return this.#state.labs.map((lab) => describeLab(lab, this.#rt.get(lab.id)))
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
    const paths = labPaths(this.#root, id)
    return buildLabReport({
      lab,
      runtime: this.#rt.get(id),
      labPaths: paths,
      logEntries: this.#rt.logs(id, 0).entries,
    })
  }

  diagnostics() {
    const sample = this.#state.labs[0]
    return buildDiagnostics({
      labRoot: this.#root,
      hostHome: this.#hostHome,
      hostProfile: this.#hostProfile,
      isElectron: this.#isElectron,
      env: this.#env,
      limits: {
        startTimeoutMs: this.#config.startTimeoutMs,
        logRingLines: this.#config.logRingLines,
        maxLabs: this.#config.maxLabs,
      },
      sampleLabHome: sample ? labPaths(this.#root, sample.id).home : null,
    })
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

  /**
   * 看 / 拍 / 点 / 打 / 跑任务。不碰实验室内部服务，只驱动它的界面。
   * 这样它对界面改版是**脆**的 —— 所以按文字找元素、找不到就报候选，而不是点空。
   */
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
      createdAt: new Date().toISOString(),
    }
    this.#rt.of(id)

    await this.#seedProfile(lab)
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

  /** 建 profile：一次性命令，`--dump-config` 只算不建、不起服务。 */
  async #seedProfile(lab) {
    const paths = labPaths(this.#root, lab.id)
    let coreBin
    try {
      coreBin = await resolveCoreBin({ version: lab.version, root: this.#root, env: this.#env })
    } catch (err) {
      this.#rt.pushLog(lab.id, 'rig', `建 profile 失败：${err?.message ?? err}`)
      return
    }
    const plan = buildSeedPlan({
      execPath: this.#execPath,
      isElectron: this.#isElectron,
      coreBin,
      profile: lab.profile,
      cwd: paths.workspace,
      home: paths.home,
      env: this.#env,
    })
    const result = await runOnce(plan, {
      onLine: (stream, line) => {
        // 建 profile 的输出里，只有「被禁用的插件行」值得留给人看，其余（整份 dump）丢掉。
        if (stream === 'err' && /disabling profile plugin row|incompatible with dsh/iu.test(line)) {
          this.#rt.pushLog(lab.id, 'seed', line)
        }
      },
    })
    this.#rt.pushLog(lab.id, 'rig', `profile 就绪（exit ${result.code ?? 'null'}${result.timedOut ? '，超时' : ''}）`)
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

    const plan = buildStartPlan({
      execPath: this.#execPath,
      isElectron: this.#isElectron,
      coreBin: await resolveCoreBin({ version: lab.version, root: this.#root, env: this.#env }),
      profile: lab.profile,
      cwd: paths.workspace,
      home: paths.home,
      env: this.#env,
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

    // 注意签名：process.js 的 attachLines 回调是 (stream, line)，不是柯里化 ——
    // 2026-11-21 重构时这里错成柯里化，结果实验室的输出一行都没被接收，看着像「启动卡死」。
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

    void this.#waitHealthy(id, rt, Date.now() + this.#config.startTimeoutMs)
    return this.get(id)
  }

  async #waitHealthy(id, rt, deadline) {
    let firstFailure = ''
    while (!this.#disposed && Date.now() < deadline) {
      if (rt.status !== STATUS.starting) return
      if (rt.url) {
        const probe = await probeOnce(rt.url)
        if (probe.ok) {
          this.#rt.setStatus(id, STATUS.running)
          this.#rt.pushLog(id, 'rig', `就绪：${rt.url.replace(/token=[^&]+/u, 'token=***')}`)
          return
        }
        // 只记第一次失败：探针会连失败几百次，全记会把日志刷爆。
        if (firstFailure === '') {
          firstFailure = probe.reason || 'unknown'
          this.#rt.pushLog(id, 'rig', `探针未通过（${firstFailure}），继续等…`)
        }
      }
      await new Promise((r) => setTimeout(r, this.#config.healthPollMs))
    }
    if (rt.status === STATUS.starting) {
      this.#rt.pushLog(
        id,
        'rig',
        `启动超时（${Math.round(this.#config.startTimeoutMs / 1000)}s）${firstFailure ? `：${firstFailure}` : ''}`,
      )
      await this.stop(id, { asCrash: true })
    }
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
    return this.get(id)
  }

  /** 切版本：只改声明并落盘；真正生效要重启（面板/工具会提示）。 */
  async setVersion(id, version) {
    const lab = findLab(this.#state, id)
    if (!lab) throw new Error(`没有实验室 ${id}`)
    const next = typeof version === 'string' && version.trim() !== '' ? version.trim() : 'host'
    // 切到某个具体版本前先确认它真的装着：否则重启时才发现，等于把失败推给下一次启动。
    if (next !== 'host') await resolveCoreBin({ version: next, root: this.#root, env: this.#env })
    lab.version = next
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
