/**
 * dsh-rig · 后端 `desktop-shell`（第二个桌面实例：同一个 Electron 可执行文件，独立 userData 与 DSH_HOME）
 *
 * ## 为什么存在
 *
 * 0.2.0 的硬需求是「面板里能直接看见实验室的桌面窗口，并在里面点」。headless 形态的实验室只有一个
 * HTTP 服务，面板只能内嵌网页 —— 那和正式版 DSH 长得一样，也就验不出桌面版真正的问题（托盘、单实例锁、
 * 更新检查、窗口快捷键）。这个后端就是「再开一个 DSH 桌面实例」的那条路：
 *
 *   command: <当前宿主可执行文件>            ← process.execPath（桌面宿主里它就是 Electron 本体）
 *   args:    ['--user-data-dir', <lab.dir>/userdata, '--profile', <profile>, ...]
 *   env:     DSH_HOME = <lab.home>          ← 与 web-core 同一个值，隔离判据一字不改
 *
 * ## ⚠️ 这一点尚未真机验证
 *
 * 本文件是**按 Electron 的已知约定写的计划**，不是已经跑通的事实。验证探针见 `docs/ROADMAP.md`
 * 第三节「验收」（面板里看见窗口 + 点击坐标命中 + 连续 10 分钟不掉线 + 正式版无感知）与
 * 第六节跨平台矩阵。在探针跑通之前，任何文档都不许把这四条写成既成事实：
 *
 *   1. **单实例锁**。DSH 桌面版是否自己 `requestSingleInstanceLock()`、锁在 userData 还是固定路径上？
 *      锁在固定路径 → 第二个实例会直接把第一个顶掉，或者自己 quit（这正是 0.2.0 最怕的结果）。
 *   2. **CLI 参数是否被转发**。`--profile` / `--port` / `--host` / `--no-open` 是 DSH **CLI** 的开关；
 *      打包后的桌面版主进程是否把它们转给内部 server，未验证。若不转发，实验室会跑在默认 profile
 *      上 —— 表现为「窗口起来了，但里面是宿主自己的会话」（比起不来更危险，会污染宿主）。
 *   3. **要不要位置参数**。Electron 打包应用的第一个位置参数不再是「app 路径」，所以这里**不传**
 *      `coreBin`（web-core 要传，因为它跑的是 `bin.js`）。若真机证明桌面版需要它，改这一处即可。
 *   4. **托盘与更新检查**。两个实例会多一个托盘图标；更新检查是否互相干扰，未验证。
 *
 * ## 参数顺序不是风格问题
 *
 * `--user-data-dir` **必须排在其它参数之前**。Electron 只认自己的开关，Chromium 侧对
 * 「出现在位置参数之后的 `--xxx`」处理是弃用的：实测过的症状是把 `--profile`、`--port` 一起吞掉，
 * 于是第二个实例起在自己默认的 profile 上（见上面第 2 条，最坏的那种失败）。所以下面用常量把
 * 「它排第一」这件事写成结构，而不是靠注释提醒后人。
 *
 * ## 本文件不做的事
 *
 * 不 spawn、不 mkdir（`supervisor` 按 `prepare()` 返回的目录去建）、不 kill。与 `web-core` 同一条理由：
 * 结构守卫 5 禁止非 IO 层 import `node:fs` / `node:child_process`，而且起进程必须只有一条路。
 */
import { join } from 'node:path'
import { sanitizeEnv } from '../lab/spawn-plan.js'
import { assertBackend, assertLabView } from './contract.js'

export const KIND = 'desktop-shell'

/**
 * 第二个实例的 userData 落点：`<labRoot>/labs/<id>/userdata`。
 *
 * 为什么放实验室目录里而不是系统默认位置：userData 里装着 Chromium 的 profile、缓存与登录态。
 * 两者共用等于「实验室用了宿主的浏览器数据」，隔离判据（`naming.assertIsolated`）管的是 DSH_HOME，
 * 管不到它 —— 所以必须显式分开，且落点要在实验室目录内，删实验室时能被一起删干净。
 */
export function userDataDir(lab) {
  assertLabView(lab)
  return join(lab.dir, 'userdata')
}

/** 排在所有其它参数之前的那个开关。单独提出来是为了让「谁在第一」可被断言。 */
export const USER_DATA_DIR_FLAG = '--user-data-dir'

/**
 * 准备：桌面实例需要自己的 userData 目录（mkdir 由 supervisor 做）。
 * `home` / `workspace` 与 web-core 一样归共有流程管，不在这里重复声明。
 */
export function prepare(lab) {
  assertLabView(lab)
  return {
    dirs: [userDataDir(lab)],
    notes: 'desktop-shell：额外需要引擎自己的 userData 目录（Chromium profile / 缓存 / 登录态）',
  }
}

/**
 * 起进程的**计划**（不执行）。
 *
 * env 与 web-core 同源：同一个 `sanitizeEnv` 白名单 + 同一个 `DSH_HOME` + `DSH_TELEMETRY_DISABLED`。
 * 唯一**必须不同**的是 `ELECTRON_RUN_AS_NODE` —— 带上它 Electron 就退化成纯 node，
 * 桌面窗口永远不会出现，而且失败得极安静（进程正常活着、也能连端口，只是没有窗口）。
 * 白名单本身已经把宿主继承来的那一个滤掉了，这里再显式删一次：这条错的代价太高，值得两道闸。
 */
export function launch(lab) {
  assertLabView(lab)
  const args = [
    USER_DATA_DIR_FLAG, userDataDir(lab),
    '--profile', lab.profile,
    '--port', String(lab.port || 0),
    '--no-open',
    '--host', '127.0.0.1',
  ]
  const env = sanitizeEnv(lab.env, {
    DSH_HOME: lab.home,
    DSH_TELEMETRY_DISABLED: '1',
  })
  delete env.ELECTRON_RUN_AS_NODE
  delete env.electron_run_as_node
  return { command: lab.execPath, args, cwd: lab.workspace, env }
}

/**
 * 收进程的**策略**（不执行）。Electron 主进程退出时通常会带走 helper，但「通常」不够 ——
 * GPU / renderer / utility 进程偶尔会残留，而残留的 Chromium 子进程会一直攥着 userData 目录，
 * 下一次启动就报 profile 被锁。所以这里要求按**进程树**收（`tree: true`）。
 */
export function stop(lab) {
  assertLabView(lab)
  return { signal: 'SIGTERM', tree: true, notes: 'Electron 带 GPU/renderer/utility 子进程，必须按树收' }
}

/**
 * 就绪判定：**弱证据**，且如实标注。
 *
 * 桌面实例和人看到的「能用」是同一个东西：窗口在、能点。这两件事本文件都看不见 —— 它们要等
 * `mirror/` 那条通道（插件从实验室内部推帧 + 报一句「已就绪」）才成为可观测证据。
 * 在那之前这里只承认两件事：进程没了 = 一定没好；解析到 URL = 至少内部 server 起来了。
 *
 * 返回 `confidence: 'weak'` 是给后续 `supervisor` 的明确信号：不许把这个 ok 当成「用户可以看了」，
 * 尤其是注释里第 2 条那个失败模式（起来了，但跑的是宿主的 profile）。
 */
export function probe(lab) {
  assertLabView(lab)
  if (lab.alive === false) {
    return { ok: false, url: null, why: '进程已退出', confidence: 'strong' }
  }
  if (typeof lab.url === 'string' && lab.url !== '') {
    return {
      ok: true,
      url: lab.url,
      why: '内部 server 已报出 URL；桌面窗口是否可见仍待真机验证（见 docs/ROADMAP.md 第三节验收）',
      confidence: 'weak',
    }
  }
  return {
    ok: false,
    url: null,
    why: '桌面实例的就绪判据尚未真机验证（见 docs/ROADMAP.md）；此处只能确认进程还活着',
    confidence: 'weak',
  }
}

export const desktopShell = assertBackend({ kind: KIND, prepare, launch, stop, probe })

export default desktopShell
