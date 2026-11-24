/**
 * dsh-rig · 一次性准备（IO 层）
 *
 * 「实验室第一次起来之前必须有」的两样东西：profile 与凭据。两者都是**跑一次就退**的命令，
 * 与 supervisor 管的「持续活着的进程」分开 —— 混在一起时，看管者会为一个一次性动作长出一堆失败分支。
 *
 * 抽出来还有一个直接原因：这一步**静默失败过**，而且没人发现。
 * `labs/lab1/home/init.err` 里躺着一条 `Cannot find module 'E:\Program'`（安装路径带空格），
 * 说明 2026-11-22 建 lab1 时 profile 根本没生成；之后每次启动都死在
 * `profile "rig-lab1" does not exist`，面板看起来就是「完全坏了」。
 *
 * 所以现在的规矩是：**create 时建一次，start 前再验一次，不在就补**，
 * 补失败要说人话并带原因，不再默默继续。判定「profile 在不在」只看目录 —— DSH 认的就是它。
 */
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSeedPlan } from './spawn-plan.js'
import { resolveCoreBin } from './core-bin.js'
import { copyCredentials, runOnce } from './seed.js'

/** `<lab home>/profiles/<profile>`。 */
export function profileDir(home, profile) {
  return join(home, 'profiles', profile)
}

/** profile 目录在不在。任何异常都算不在（不能因为 stat 失败就把实验室判死）。 */
export async function profileExists(home, profile) {
  try {
    const info = await stat(profileDir(home, profile))
    return info.isDirectory()
  } catch {
    return false
  }
}

/**
 * 跑一次 `--from-default-profile … --dump-config` 建 profile。
 *
 * 不抛：失败只落日志，由 `ensureProfile` 用「目录在不在」做最终判据 ——
 * 子进程的非零退出码不该代替文件系统的证据。
 *
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function seedProfile(options) {
  const { lab, home, workspace, execPath, isElectron, version, root, env, log } = options
  let coreBin
  try {
    coreBin = await resolveCoreBin({ version, root, env })
  } catch (err) {
    log('rig', `建 profile 失败：${err?.message ?? err}`)
    return { ok: false, reason: 'core-missing' }
  }
  const plan = buildSeedPlan({ execPath, isElectron, coreBin, profile: lab.profile, cwd: workspace, home, env })
  const result = await runOnce(plan, {
    onLine: (stream, line) => {
      // 只挑有用的几类，别把整段 pnpm 输出灌进环形缓冲。`Cannot find module` 是路径出错的指纹。
      if (stream === 'err' && /disabling profile plugin row|incompatible with dsh|Cannot find module|ENOENT/iu.test(line)) {
        log('seed', line)
      }
    },
  })
  log('rig', `profile 就绪（exit ${result.code ?? 'null'}${result.timedOut ? '，超时' : ''}）`)
  return { ok: result.code === 0, reason: result.timedOut ? 'timeout' : null }
}

/**
 * 确保 profile 在：已在就什么都不做；不在就补建一次，补完再用目录验一次。
 *
 * @returns {Promise<{ok: boolean, created: boolean, reason: string|null}>}
 */
export async function ensureProfile(options) {
  const { lab, home, workspace, log } = options
  if (await profileExists(home, lab.profile)) return { ok: true, created: false, reason: null }

  log('rig', `profile ${lab.profile} 不存在，补建一次（这步以前只在创建时跑，静默失败过）`)
  await mkdir(join(home, 'profiles'), { recursive: true })
  const seeded = await seedProfile(options)
  const ok = await profileExists(home, lab.profile)
  if (!ok) log('rig', `补建失败：${seeded.reason || 'seed 命令没生成 profile'}`)
  return { ok, created: true, reason: ok ? null : seeded.reason || 'seed-failed' }
}

export { copyCredentials }
