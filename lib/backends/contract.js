/**
 * dsh-rig · 后端契约（纯逻辑层：零 `node:` 内建、零 IO、零外部包）
 *
 * ## 为什么存在
 *
 * 0.1.x 里「怎么把实验室拉起来」这句话只写在 `lab/spawn-plan.js` 的一个函数里。0.2.0 要让它有两种
 * 形态 —— headless（`web-core`）与第二个桌面实例（`desktop-shell`），再往后可能还有别的。
 * 抽契约不是为了「可扩展」这个漂亮词，而是为了下面这一句：**`lab/supervisor.js` 从此只认四个方法名**。
 * 它不该认识 Electron，不该认识参数顺序，也不该知道「桌面版要不要 `--user-data-dir`」。
 *
 * 面板上没有开关（0.2.0 决策 1：不提供 runtime 切换），用哪个后端只由 `backends/index.js` 一处决定。
 *
 * ## 一条与 ROADMAP 第三节不同的硬决定：后端只产出「计划」，不执行 IO
 *
 * ROADMAP 写的是 `launch(lab) → { pid }`。这里改成 `launch(lab) → plan`（`{command, args, cwd, env}`）。
 * 三条理由，任何一条都足以定案：
 *
 *   1. **结构守卫 5**（`test/structure.test.mjs`）禁止非 IO 层 import `node:fs` / `node:child_process`。
 *      后端自己 spawn，测试当场红；而且「起的到底是哪条命令」就没法用断言钉住了。
 *   2. 起进程只能有一条路 —— `lab/process.js` 的 `spawnChild` + `attachLines`（日志接线、就绪解析都在那儿）。
 *      多一条路就多一处「实验室输出进不了面板」的 Bug（0.1.4 真踩过）。
 *   3. 计划是纯数据。当年 `lab/spawn-plan.js` 能把「不继承宿主凭据」写成单测，靠的就是这一点。
 *
 * 同一个逻辑套在另外两个方法上：`prepare()` 返回「要建哪些目录」，`stop()` 返回「该怎么收」，
 * 真正的 mkdir / kill 仍由 `supervisor` 与 `process.js` 做。后端因此能在任何进程、任何平台上被穷举断言。
 *
 * ## 四个方法的签名与返回
 *
 * ```js
 * prepare(lab) → { dirs: string[], env?: Record<string,string>, notes?: string }
 *     // 起的进程需要、而现在还没有的目录。空数组是合法的（headless 就不需要额外目录）。
 *     // 不做 mkdir：见上面第 1 条。
 *
 * launch(lab)  → { command: string, args: string[], cwd: string, env: Record<string,string> }
 *     // 交给 `spawnChild(plan)` 的那份计划。**必须**是完整计划，不许让 supervisor 再往里补字段 ——
 *     // 补字段就等于把后端知识漏回看管层。
 *
 * stop(lab)    → { signal: 'SIGTERM'|'SIGKILL', tree?: boolean, notes?: string }
 *     // `tree: true` 表示必须连子进程一起收（Electron 会带 GPU/renderer/utility 进程）。
 *
 * probe(lab)   → { ok: boolean, url?: string|null, why?: string, confidence: 'strong'|'weak' }
 *     // 就绪判定。「有没有起来」的证据形态每个后端不一样，所以判定权在各自手里。
 *     // `confidence: 'weak'` 是**诚实的出口**：这一版的桌面实例还没有 verified 的就绪证据，
 *     // 宁可自报弱，也不许拿「进程还活着」冒充「已经能用」。
 * ```
 *
 * ## `lab` 是什么（lab 视图）
 *
 * 后端拿到的既不是 `labs.json` 里的记录，也不是 supervisor 本身，而是一份**扁平的只读视图**：
 * 记录里的静态字段 + 那次启动解析出来的路径与命令材料。理由：记录里没有 `dir` / `home`（那是
 * `lab/layout.js` 算的），而 supervisor 内部字段（`#env`、`#execPath`）又不该被后端 reverse-engineer。
 *
 * 必填（`assertLabView` 会逐条验）：
 *   id, profile, root, dir, home, workspace, execPath, coreBin  —— 均为非空字符串
 *   env       —— 对象（宿主环境；后端只许经 `sanitizeEnv` 白名单过滤后使用）
 *   isElectron —— 布尔（`process.versions.electron` 是否为真）
 * 可选：port（正整数，缺省 0）、version、name、alive（布尔，来自 `process.js` 的 `isAlive`）、
 *       url（已解析出的 `http://127.0.0.1:<port>/?token=...`）、pid。
 *
 * 早验一步的价值：路径字段拼错（`home` 写成 `homes`）在 0.1.x 会变成「实验室起来了但读的是宿主的 state」，
 * 那种 Bug 从日志里看不出来。这里直接抛，抛的时候点名缺哪个。
 */

/** 已知后端种类。新增一个后端 = 在这里加一行 + 在 `backends/` 加一个文件，别处不用改。 */
export const BACKEND_KINDS = Object.freeze(['web-core', 'desktop-shell'])

/** 契约要求的四个方法，顺序就是调用顺序。 */
export const BACKEND_METHODS = Object.freeze(['prepare', 'launch', 'stop', 'probe'])

/** lab 视图里必须是「非空字符串」的字段。 */
const LAB_STRING_FIELDS = Object.freeze(['id', 'profile', 'root', 'dir', 'home', 'workspace', 'execPath', 'coreBin'])

/** probe 允许的置信度。 */
export const PROBE_CONFIDENCE = Object.freeze(['strong', 'weak'])

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/**
 * 校验一个后端是否满足契约。返回 candidate 本身（便于 `const x = assertBackend({...})`）。
 *
 * 抛错必须说清缺哪个方法 —— 这条规矩来自 0.1.6 的教训：`profile does not exist` 那种
 * 「只报结果不报缺什么」的错误，害我们在面板上猜了两天。
 *
 * @template T
 * @param {T} candidate
 * @returns {T}
 */
export function assertBackend(candidate) {
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('assertBackend: 后端必须是对象（收到 ' + (candidate === null ? 'null' : typeof candidate) + '）')
  }
  const { kind } = candidate
  if (!isNonEmptyString(kind)) {
    throw new Error('assertBackend: 后端缺 kind（应为 ' + BACKEND_KINDS.join(' / ') + ' 之一）')
  }
  if (!BACKEND_KINDS.includes(kind)) {
    throw new Error(`assertBackend: 未知后端 kind "${kind}"；已知：${BACKEND_KINDS.join(' / ')}（新增后端要先在 BACKEND_KINDS 里登记）`)
  }
  const problems = []
  for (const name of BACKEND_METHODS) {
    const value = candidate[name]
    if (typeof value === 'function') continue
    problems.push(value === undefined ? `${name}（完全没有）` : `${name}（是 ${typeof value}，不是函数）`)
  }
  if (problems.length > 0) {
    throw new Error(`assertBackend: 后端 "${kind}" 缺方法 → ${problems.join('、')}；契约要求 ${BACKEND_METHODS.join(' / ')}`)
  }
  return candidate
}

/**
 * 校验 lab 视图。一次性列出**所有**缺的字段，而不是遇到第一个就抛 —— 少一个字段的修法是一样的，
 * 分三次跑测试没有意义。
 *
 * @param {object} lab
 * @returns {object} 原样返回
 */
export function assertLabView(lab) {
  if (lab === null || typeof lab !== 'object') {
    throw new Error('assertLabView: lab 视图必须是对象（应为 labPaths() 结果 + 启动材料的扁平合并）')
  }
  const problems = LAB_STRING_FIELDS.filter((name) => !isNonEmptyString(lab[name])).map((name) => `${name}（非空字符串）`)
  if (lab.env === null || typeof lab.env !== 'object' || Array.isArray(lab.env)) problems.push('env（对象）')
  if (typeof lab.isElectron !== 'boolean') problems.push('isElectron（布尔）')
  if (lab.port !== undefined && lab.port !== null && !(Number.isInteger(lab.port) && lab.port >= 0)) {
    problems.push('port（非负整数，可省略）')
  }
  if (problems.length > 0) {
    throw new Error(`assertLabView: lab 视图缺字段 → ${problems.join('、')}`)
  }
  return lab
}

/**
 * 校验 `launch()` 交出来的启动计划。`env` 只查形状不查内容：白名单是 `sanitizeEnv` 的职责，
 * 这里多查一遍只会造成第二份判据。
 *
 * @param {object} plan
 * @returns {object} 原样返回
 */
export function assertPlan(plan) {
  if (plan === null || typeof plan !== 'object') throw new Error('assertPlan: 启动计划必须是对象')
  if (!isNonEmptyString(plan.command)) throw new Error('assertPlan: command 必须是非空字符串（可执行文件绝对路径）')
  if (!Array.isArray(plan.args) || plan.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('assertPlan: args 必须是字符串数组（别再塞 number，跨平台转义会出事）')
  }
  if (!isNonEmptyString(plan.cwd)) throw new Error('assertPlan: cwd 必须是非空字符串')
  const env = plan.env
  if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new Error('assertPlan: env 必须是对象')
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') throw new Error(`assertPlan: env.${name} 必须是字符串`)
  }
  return plan
}

/** 给诊断面板 / 日志用的一份契约摘要（冻结，防止有人改到手）。 */
export const CONTRACT = Object.freeze({
  kinds: BACKEND_KINDS,
  methods: BACKEND_METHODS,
  labView: Object.freeze({ requiredStrings: LAB_STRING_FIELDS, requiredOther: Object.freeze(['env', 'isElectron']), optional: Object.freeze(['port', 'version', 'name', 'alive', 'url', 'pid']) }),
  probeConfidence: PROBE_CONFIDENCE,
})
