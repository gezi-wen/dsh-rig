/**
 * dsh-rig · 实验室的插件清单与卸载（IO 层）
 *
 * 三件事放一起（安装仍在 install.js）：它们都只碰实验室自己的 profile 目录，
 * 且都是「一次性命令 + 一次读盘」，与生命周期无关 —— 所以不塞进 supervisor。
 *
 * 列清单**现读** `profiles/<p>/package.json` 的 dependencies，不做缓存：
 * 装/卸载本来就不频繁，而缓存会引入一类「界面说装了、实际没装」的错觉。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildPluginPlan } from './spawn-plan.js'
import { resolveCoreBin } from './core-bin.js'
import { runOnce } from './seed.js'
import { normalizeSpec } from './install.js'

/** pnpm remove 也可能要联网（更新 lockfile），给同样的上限。 */
const REMOVE_TIMEOUT_MS = 300_000

/**
 * 实验室已装的插件。
 * @returns {Promise<Array<{name: string, spec: string}>>}
 */
export async function listPlugins({ home, lab }) {
  const file = join(home, 'profiles', lab.profile, 'package.json')
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    const deps = raw && typeof raw.dependencies === 'object' && raw.dependencies !== null ? raw.dependencies : {}
    return Object.entries(deps)
      .map(([name, spec]) => ({ name, spec: String(spec) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    // profile 还没建、或文件坏：当作「一个都没有」，不要把面板打成错误态。
    return []
  }
}

/**
 * 从实验室 profile 卸掉一个插件。
 * @returns {Promise<{ok: boolean, exit: number|null, reason: string|null}>}
 */
export async function removePlugin(options) {
  const { lab, home, workspace, execPath, isElectron, version, root, env, log } = options
  const spec = normalizeSpec(options.spec)
  if (!spec.ok) return { ok: false, exit: null, reason: spec.reason }

  let coreBin
  try {
    coreBin = await resolveCoreBin({ version, root, env })
  } catch (err) {
    log('rig', `卸载失败：找不到宿主 core（${err?.message ?? err}）`)
    return { ok: false, exit: null, reason: 'core-missing' }
  }

  const plan = buildPluginPlan({ action: 'remove', execPath, isElectron, coreBin, profile: lab.profile, spec: spec.value, cwd: workspace, home, env })
  log('rig', `卸载插件：${spec.value}（profile=${lab.profile}）`)
  const result = await runOnce(plan, {
    timeoutMs: REMOVE_TIMEOUT_MS,
    onLine: (stream, line) => {
      if (stream === 'err' || /removed|already|not found|ERR_|error/iu.test(line)) log(stream, line)
    },
  })
  const ok = result.code === 0
  log('rig', ok ? `已卸载 ${spec.value}（重启实验室后生效）` : `卸载失败：exit ${result.code ?? 'null'}`)
  return { ok, exit: result.code ?? null, reason: ok ? null : result.timedOut ? 'timeout' : 'exit-nonzero' }
}
