/**
 * dsh-rig · 后端选择（全仓唯一「用哪个后端」的地方）
 *
 * ## 为什么存在
 *
 * 0.2.0 有两个后端，而**面板上不给开关**（决策 1：不提供 runtime 切换，分支越少越稳）。
 * 既然用户不能选，就必须有一个地方替用户判，而且只能有一处 —— 否则「某次启动为什么是 headless」
 * 会变成需要读三个文件才能回答的问题。这里就是那一处：`pick()` 几行，输入是事实，输出是后端。
 *
 * ## 输入是事实，不是环境
 *
 * `hasDisplay` 由**调用方**算好传进来：Linux 看 `DISPLAY` / `WAYLAND_DISPLAY`，Windows / macOS 恒 true。
 * 本文件不读 `process.env`，也不读 `process.platform` —— 两个理由：
 *   1. 读环境变量 = 这段逻辑只能在本机跑，没法在测试里穷举「SSH 里的 Linux」这种场景；
 *   2. 0.1.x 的教训（`naming.profileFromInstallPath` 的注释里那条）：从别的会话派生的进程会把父进程的
 *      环境一起继承下去，于是「起了 `--profile web` 却以为自己是 desktop」。
 *      环境变量只在那一个恰好知道它代表什么的地方读一次，然后就别再传了。
 *
 * 调用方的写法大致是（现在还没有接线，step 5 接 `supervisor.start()` 时照这个来）：
 *
 * ```js
 * const platform = process.platform
 * const hasDisplay = platform === 'linux' ? Boolean(env.DISPLAY || env.WAYLAND_DISPLAY) : true
 * const { backend, reason } = pick({ hasDisplay, platform })
 * ```
 *
 * ## 只有 Linux 会降级
 *
 * Windows / macOS 上「有没有图形会话」这个话题在实验室场景里是伪命题：宿主自己是桌面应用，
 * 用户点得到面板就说明有会话。把 `hasDisplay: false` 在这两个平台上当降级理由，只会制造
 * 「明明看得见面板，实验室却退回网页」这种没人能解释的行为。
 * Linux 才是真会遇到的：SSH 进去、systemd 里跑、容器里跑 —— 那些环境里没有 X/Wayland，
 * 起桌面实例只会得到一个更慢的失败。所以降级是**兜底**，不是选项。
 */
import { assertBackend } from './contract.js'
import { webCore } from './web-core.js'
import { desktopShell } from './desktop-shell.js'

export { webCore, desktopShell }
export { CONTRACT, assertBackend, assertLabView, assertPlan } from './contract.js'

/** 按 kind 取后端。给「日志里回显种类」或将来按配置覆盖的调用方用。 */
export const BACKENDS = Object.freeze({ 'web-core': webCore, 'desktop-shell': desktopShell })

/** 降级原因的唯一字面量。日志与面板文案都对它做比较，别在别处另写一份字符串。 */
export const HEADLESS_REASON = 'headless'

/** `platform` 是否属于「有图形会话这回事」的那一类（只认 Linux 系）。 */
function isLinuxLike(platform) {
  const os = platform.trim().toLowerCase()
  return os === 'linux' || os.startsWith('linux')
}

/**
 * 选后端。
 *
 * @param {object} input
 * @param {boolean} input.hasDisplay Linux 上是否有图形会话（`DISPLAY` / `WAYLAND_DISPLAY` 非空）；
 *        非 Linux 平台传什么都行，传 `true` 最诚实。
 * @param {string} input.platform `process.platform` 的值（`win32` / `darwin` / `linux` / …）。
 * @returns {{backend: object, reason: string|null}} `reason` 为 `'headless'` 表示降级，否则 `null`。
 */
export function pick({ hasDisplay, platform } = {}) {
  if (typeof platform !== 'string' || platform.trim() === '') {
    throw new Error('pick: 必须显式传 platform（win32 / darwin / linux）—— 这里不读 process.platform')
  }
  const linux = isLinuxLike(platform)
  if (!linux) {
    // Windows / macOS：恒桌面实例。hasDisplay 不参与判定，见文件头「只有 Linux 会降级」。
    return { backend: desktopShell, reason: null }
  }
  if (typeof hasDisplay !== 'boolean') {
    // 猜错的代价不对称：猜「有显示」会在无图形会话里起一个必然失败的窗口；
    // 猜「没显示」会让能用的机器退回网页还不给解释。所以不猜。
    throw new Error('pick: Linux 上必须显式传 hasDisplay（Boolean(DISPLAY || WAYLAND_DISPLAY)）—— 这里不读环境变量')
  }
  if (hasDisplay === false) {
    return { backend: webCore, reason: HEADLESS_REASON }
  }
  return { backend: desktopShell, reason: null }
}

/** 给诊断/日志用的一句话。没有降级时返回 null，调用方不必自己判空。 */
export function describePick({ backend, reason }) {
  assertBackend(backend)
  if (reason === HEADLESS_REASON) return `${backend.kind}（无图形会话，已降级：这是兜底形态，不是选项）`
  if (reason) return `${backend.kind}（${reason}）`
  return `${backend.kind}`
}
