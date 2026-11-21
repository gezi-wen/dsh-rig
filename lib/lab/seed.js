/**
 * dsh-rig · 一次性子进程与凭据复制（IO 层）
 *
 * 两件「跑一次就完事」的事都在这儿：
 *   1. 建 profile（`--from-default-profile web --dump-config`，只算不建、不起服务）；
 *   2. 把宿主凭据复制进实验室 home。
 *
 * 为什么和 `supervisor.js` 分开：看管者管的是「持续活着的进程」（spawn/kill/探活/日志），
 * 这里管的是「跑一次、等它退出的命令」。两者混在一起时，看管者会为了一个一次性动作长出一堆分支。
 */
import { spawn } from 'node:child_process'
import { copyFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'

/** 建 profile 的默认超时。只算不建，正常几秒内就退。 */
const SEED_TIMEOUT_MS = 90_000

/**
 * 跑一个一次性子进程，逐行回调 stdout/stderr，等它退出。
 * **不抛**：失败只是「日志里多一行」，由调用方决定要不要中止。
 *
 * @returns {Promise<{code: number|null, timedOut: boolean}>}
 */
export function runOnce(plan, { onLine, timeoutMs = SEED_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, windowsHide: true })
    } catch (err) {
      onLine?.('rig', `启动失败：${err?.message ?? err}`)
      resolve({ code: null, timedOut: false, error: String(err?.message ?? err) })
      return
    }
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => {
      onLine?.('rig', `超时（${Math.round(timeoutMs / 1000)}s），已终止`)
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ code: null, timedOut: true })
    }, timeoutMs)

    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => onLine?.('out', line))
    if (child.stderr) createInterface({ input: child.stderr }).on('line', (line) => onLine?.('err', line))
    child.on('error', (err) => {
      clearTimeout(timer)
      onLine?.('rig', `子进程错误：${err?.message ?? err}`)
      finish({ code: null, timedOut: false, error: String(err?.message ?? err) })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      finish({ code: code ?? null, timedOut: false })
    })
  })
}

/**
 * 宿主凭据 → 实验室 home。
 *
 * 为什么走文件不走环境变量：环境变量会被子进程里的任何东西读走（包括实验室里正在开发的插件），
 * 而 DSH 自己就是从 `<DSH_HOME>/.credentials.yaml` 取的。显式、可关、可清除。
 *
 * @returns {Promise<boolean>} 复制成功与否（不抛）
 */
export async function copyCredentials({ fromHome, toHome }) {
  try {
    await copyFile(join(fromHome, '.credentials.yaml'), join(toHome, '.credentials.yaml'))
    return true
  } catch {
    return false
  }
}
