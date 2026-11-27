/**
 * dsh-rig · 往实验室的 profile 里装插件（IO 层）
 *
 * 走的是 DSH 自己的路：`dsh plugin --profile <p> add <spec>` ——
 * 与界面「插件」页的「添加插件」是同一套底层（那条命令就是把参数转发给 pnpm）。
 * 我们只负责把 `DSH_HOME` 指到实验室、把输出接进它的日志环形缓冲。
 *
 * 为什么不让宿主代劳：宿主自己的 `plugin_manager` 装的是**宿主 profile**。
 * 实验室有独立 `DSH_HOME` 与独立 profile，必须由实验室那一侧装，否则装到宿主身上就白装了。
 *
 * 装完**不会自动生效**：DSH 的插件注入表是进程启动时收集一次的，所以调用方要提示重启实验室。
 */
import { buildPluginPlan } from './spawn-plan.js'
import { resolveCoreBin } from './core-bin.js'
import { runOnce } from './seed.js'

/** pnpm 装包可能很慢（拉 tarball、跑 build），给足时间但别无限。 */
const INSTALL_TIMEOUT_MS = 300_000

/** 只接受看起来像包装说明的字符串：空、超长、带换行的直接拒。 */
export function normalizeSpec(spec) {
  const value = typeof spec === 'string' ? spec.trim() : ''
  if (value === '') return { ok: false, reason: 'empty' }
  if (value.length > 512) return { ok: false, reason: 'too-long' }
  if (/[\r\n]/u.test(value)) return { ok: false, reason: 'invalid' }
  return { ok: true, value }
}

/**
 * @returns {Promise<{ok: boolean, exit: number|null, timedOut: boolean, reason: string|null}>}
 */
export async function installPlugin(options) {
  const { lab, home, workspace, execPath, isElectron, version, root, env, log } = options
  const spec = normalizeSpec(options.spec)
  if (!spec.ok) return { ok: false, exit: null, timedOut: false, reason: spec.reason }

  let coreBin
  try {
    coreBin = await resolveCoreBin({ version, root, env })
  } catch (err) {
    log('rig', `装插件失败：找不到宿主 core（${err?.message ?? err}）`)
    return { ok: false, exit: null, timedOut: false, reason: 'core-missing' }
  }

  const plan = buildPluginPlan({ execPath, isElectron, coreBin, profile: lab.profile, spec: spec.value, cwd: workspace, home, env })
  log('rig', `装插件：${spec.value}（profile=${lab.profile}）`)
  const result = await runOnce(plan, {
    timeoutMs: INSTALL_TIMEOUT_MS,
    onLine: (stream, line) => {
      // pnpm 的输出很吵，只留错误与安装结果这类有信息量的行。
      if (stream === 'rig' || stream === 'err' || /added|up to date|already|installed|ERR_|error/iu.test(line)) log(stream, line)
    },
  })

  const timedOut = Boolean(result.timedOut)
  const ok = result.code === 0
  log('rig', ok ? `插件装好了：${spec.value}（重启实验室后生效）` : `装插件失败：exit ${result.code ?? 'null'}${timedOut ? '，超时' : ''}`)
  return { ok, exit: result.code ?? null, timedOut, reason: ok ? null : timedOut ? 'timeout' : 'exit-nonzero' }
}
