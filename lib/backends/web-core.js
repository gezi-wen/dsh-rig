/**
 * dsh-rig · 后端 `web-core`（headless：把 DSH 的 `lib/bin.js` 当纯 node 进程跑）
 *
 * ## 为什么存在
 *
 * 这是 0.1.x 唯一的形态，也是 0.2.0 之后的**兜底**形态：宿主跑在 SSH / 无 `DISPLAY` 的 Linux 上时，
 * 没有桌面可以给实验室，于是退回「一个只有 HTTP 的 DSH」（见 `backends/index.js` 的 `pick`）。
 *
 * 它存在的第二个理由更实际：**参数组装必须只有一份**。0.1.x 里这段逻辑长在
 * `lab/spawn-plan.js:buildStartPlan()` 上，0.2.0 不能把它复制一份进来 —— 一旦复制，「端口默认值」
 * 「不写 `web` 子命令」这些踩过坑的细节就会在两边各自漂。所以这里**import 复用**，只做「lab 视图 →
 * buildStartPlan 入参」的搬运。
 *
 * 本文件不做的事：不 spawn（交给 `lab/process.js`）、不 mkdir（交给 `supervisor` / `provision.js`）、
 * 不解析 stdout 里的 URL（`spawn-plan.parseLabUrl` 由看管层调用，因为那是日志回调的一部分）。
 * 于是它零 IO、可穷举断言 —— 结构守卫 5 也要求如此。
 */
import { buildStartPlan } from '../lab/spawn-plan.js'
import { assertBackend, assertLabView } from './contract.js'

/** headless 形态自己的日志前缀来源：给 supervisor 写「这次用的是哪条路」。 */
export const KIND = 'web-core'

/**
 * 准备：headless 不需要额外目录。
 *
 * `home` / `workspace` 的 mkdir 与 profile 补建都是**所有形态共有**的动作，
 * 归 `supervisor` + `provision.js` 管（0.1.6 已经把「start 前验一次 profile」放那儿了）。
 * 这里返回空数组是结论，不是占位：多返回一个目录就等于让 supervisor 多建一个没人用的壳。
 */
export function prepare(lab) {
  assertLabView(lab)
  return {
    dirs: [],
    notes: 'headless：profile 与凭据走 provision.js，进程靠 bin.js 直跑，无需额外目录',
  }
}

/**
 * 起进程的**计划**（不执行）。行为与 0.1.6 的 `buildStartPlan` 逐字段一致：
 *
 *   command: execPath
 *   args:    [coreBin, '--profile', profile, '--port', String(port || 0), '--no-open', '--host', '127.0.0.1']
 *   env:     白名单 + DSH_HOME + DSH_TELEMETRY_DISABLED (+ Electron 下 ELECTRON_RUN_AS_NODE=1)
 *
 * 三个为什么仍留在 `spawn-plan.js` 的注释里（那里是唯一真相）：不能写 `web` 子命令、端口要固定、
 * 环境变量只走白名单。这里不重复抄一遍，避免两处说法不一致。
 */
export function launch(lab) {
  assertLabView(lab)
  return buildStartPlan({
    execPath: lab.execPath,
    isElectron: lab.isElectron === true,
    coreBin: lab.coreBin,
    profile: lab.profile,
    cwd: lab.workspace,
    home: lab.home,
    env: lab.env,
    port: lab.port || 0,
  })
}

/**
 * 收进程的**策略**（不执行）。headless 是一个 node 主进程：它自己挂了就完了，
 * 不需要按进程树兜底（`tree: false`）。真起进程时 `process.js` 仍会做一次兜底清扫，
 * 这条只是告诉看管层「这里没有已知的、会脱离父进程的后代」。
 */
export function stop(lab) {
  assertLabView(lab)
  return { signal: 'SIGTERM', tree: false, notes: 'headless 是单进程，SIGTERM 足够' }
}

/**
 * 就绪判定：headless 的 DSH 一定会在 stdout 打印带 token 的 URL
 * （`spawn-plan.parseLabUrl` 认的那一条）。所以「解析到 URL」= 真的能用了，这是 strong 证据。
 *
 * `lab.alive === false` 优先于「还没打印 URL」—— 进程已经没了，再等就只是在等超时。
 */
export function probe(lab) {
  assertLabView(lab)
  if (lab.alive === false) {
    return { ok: false, url: null, why: '进程已退出', confidence: 'strong' }
  }
  if (typeof lab.url === 'string' && lab.url !== '') {
    return { ok: true, url: lab.url, confidence: 'strong' }
  }
  return { ok: false, url: null, why: '还没打印出带 token 的 URL（headless 必然会有这一行）', confidence: 'strong' }
}

export const webCore = assertBackend({ kind: KIND, prepare, launch, stop, probe })

export default webCore
