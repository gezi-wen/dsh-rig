/**
 * dsh-rig · host half（组合根）
 *
 * 装配顺序：状态 → 看管者 → HTTP 边 → 工具面 → 卸载清理。
 * 每一块都走 `ctx.inject`（**软依赖**）：没有 webServer 的宿主（例如 headless）就不装路由，
 * 但没有 tools 的宿主不该让整个插件待机 —— 这是 sage-mem `tools-mount.js` 里那条教训。
 *
 * 日志纪律：`ctx.logger()` 的输出不进 stdout，三级验证看不到。这里一律 `console.log`。
 */
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { LabSupervisor } from './lab/supervisor.js'
import { mountRoutes } from './http/routes.js'
import { labPaths, resolveLabRoot } from './lab/layout.js'
import { profileFromInstallPath } from './lab/naming.js'
import { listCachedVersions, listRemoteVersions, resolveHostCore } from './lab/versions.js'
import { mountLabTools } from './tools/mount.js'
import { createTitleLookup } from './lab/session-title.js'
import { DEFAULTS } from './lab/constants.js'

export const name = 'dsh-rig'

/** 三级验证的第三级看这行。 */
export const RIG_STAGE = 'm2-report'

/**
 * 宿主 DSH_HOME：环境变量优先；桌面版会给 `DSH_PROFILE_DIR`（`<home>/profiles/<名>`），
 * 从它往上退两级；都没有就按官方默认 `~/.dsh`。
 */
export function resolveHostHome(env) {
  if (env.DSH_HOME) return env.DSH_HOME
  if (env.DSH_PROFILE_DIR) return dirname(dirname(env.DSH_PROFILE_DIR))
  return join(homedir(), '.dsh')
}

/**
 * 宿主 profile 名。
 *
 * ⚠️ 不能只信 `DSH_PROFILE`：从别的会话派生出来的进程会把这个变量一起继承下去
 * （2026-11-21 实测：起着 `--profile web` 的实例，插件却报 desktop，因为父进程把它带进来了）。
 * `DSH_PROFILE_DIR` 是**实际挂载的目录**，它的 basename 才是当时真正在跑的 profile。
 */
export function resolveHostProfile(env, moduleUrl = import.meta.url) {
  // 1) 自己的安装位置（最可靠，见 naming.profileFromInstallPath 的注释）
  const fromPath = profileFromInstallPath(moduleUrl)
  if (fromPath) return fromPath
  // 2) 环境变量兜底
  if (env.DSH_PROFILE_DIR) {
    const base = env.DSH_PROFILE_DIR.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop()
    if (base) return base
  }
  return env.DSH_PROFILE || 'web'
}

export function apply(ctx, config = {}) {
  const env = process.env
  const hostHome = resolveHostHome(env)
  const root = resolveLabRoot(config.labRoot, env)
  const isElectron = Boolean(process.versions.electron)
  const core = resolveHostCore(env)

  console.log(
    `[dsh-rig] host half loaded · stage=${RIG_STAGE} · home=${hostHome} · core=${core.bin ?? '(missing)'}(${core.source}) · electron=${isElectron}`,
  )

  // iframe 稳定入口的签名：每次宿主启动换一份，由路由层校验（原因见 http/routes.js 里那段注释）。
  const frameSig = randomBytes(12).toString('hex')

  // 占用者显示成会话标题（与左侧栏同一份）；`sessions` / `sessionTitle` 缺失时由它自己退回空串。
  const titleOf = createTitleLookup(ctx)

  const supervisor = new LabSupervisor({    root,
    hostHome,
    hostProfile: resolveHostProfile(env),
    execPath: process.execPath,
    isElectron,
    env,
    log: (line) => console.log(line),
    config,
  })

  const versions = {
    cached: () => listCachedVersions(labPaths(root, null).coreDir),
    remote: () =>
      listRemoteVersions({
        execPath: process.execPath,
        isElectron,
        env,
        cacheMs: config.versionsCacheMs ?? DEFAULTS.versionsCacheMs,
      }),
  }

  void supervisor
    .load()
    .then((state) => console.log(`[dsh-rig] labs.json 读取完成：${state.labs.length} 个实验室`))
    .catch((err) => console.warn(`[dsh-rig] labs.json 读取失败：${err?.message ?? err}`))

  // HTTP 边：没有 webServer 的宿主（headless）直接跳过，不影响别的一半。
  try {
    ctx.inject(['webServer'], (inner) => mountRoutes(inner, { supervisor, versions, frameSig, titleOf }))
  } catch (err) {
    console.warn(`[dsh-rig] webServer 不可用，面板将拿不到数据：${err?.message ?? err}`)
  }

  // 工具面：`plugin_lab` 常驻；`lab_ui`（界面操作）按权限动态注册 —— 没授权就不存在，
  // 免得一个带一堆参数的 schema 每轮都占上下文。挂载逻辑在 lib/tools/mount.js。
  console.log(
    `[dsh-rig] 探测：tools 可见=${Boolean(ctx.get && ctx.get('tools'))} systemPrompt 可见=${Boolean(ctx.get && ctx.get('systemPrompt'))}`,
  )
  try {
    ctx.inject(['tools'], (inner) => {
      try {
        console.log('[dsh-rig] tools 服务就绪，开始挂工具')
        const dispose = mountLabTools(inner.tools, { supervisor, versions, titleOf, log: (line) => console.log(line) })
        if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-rig tools')
      } catch (err) {
        // cordis 会吞掉 inject 回调里的异常；自己说出来，否则看起来像「什么都没发生」。
        // （2026-11-21 就是这么被坑的：`mountLabTools is not defined` 一声不响，面板照常起。）
        console.warn(`[dsh-rig] 挂工具失败：${err?.stack ?? err}`)
      }
    })
  } catch (err) {
    console.warn(`[dsh-rig] inject(tools) 不可用：${err?.message ?? err}`)
  }

  // 卸载（插件停用 / 宿主退出）：把所有还活着的实验室停掉，不留孤儿进程。
  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        console.log('[dsh-rig] 卸载：停止所有实验室')
        void supervisor.disposeAll()
      },
      'dsh-rig dispose',
    )
  }
}
