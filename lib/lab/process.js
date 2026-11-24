/**
 * dsh-rig · 子进程机制（IO 层）
 *
 * 只回答「怎么起、怎么读、怎么杀」这三件事，不判断谁该起、谁该杀。
 * 和 `supervisor.js` 的分工：那边是**实验室的业务**（状态机、持久化、装配），
 * 这边是**操作系统的机制**。分开之后，换掉终止方式（比如将来加 Job Object）
 * 只需要动这一个文件。
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'

const execFileAsync = promisify(execFile)

/** 起一个后台子进程。stdio 固定：stdin 不要，标准输出/错误各一根管道。 */
export function spawnChild(plan) {
  return spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * 这个 pid 现在还活着吗。
 *
 * 用 `process.kill(pid, 0)`：不发信号、只做存在性检查，Windows / macOS / Linux 行为一致。
 * `EPERM` 说明进程在、只是没权限动它 —— 那是「活着」而不是「没有」，
 * 判反了会让别人的实验室被当成自己的（2026-11-24 那类锁死的反面）。
 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

/** 把子进程的两根输出管道都接到同一个回调（逐行，已去换行）。 */
export function attachLines(child, onLine) {
  if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => onLine('out', line))
  if (child.stderr) createInterface({ input: child.stderr }).on('line', (line) => onLine('err', line))
}

/**
 * 杀掉整棵进程树。
 *
 * Windows 用 `taskkill /T`：DSH 会再派生子进程（MCP、终端、子代理），只杀父进程会留一堆孤儿。
 * 判据是**pid 必须来自我们自己 spawn 的那棵树**，绝不按端口或名字盲杀。
 */
export async function killTree(pid, timeoutMs = 15_000) {
  if (!pid) return
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: timeoutMs })
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* 已经没了 */
  }
}
