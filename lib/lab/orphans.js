/**
 * dsh-rig · 孤儿回收（IO 层）
 *
 * 为什么需要它：宿主被硬杀（崩溃、任务管理器结束、`taskkill /F`）时，插件没有机会跑
 * `disposeAll`，于是它派出去的实验室进程会活下来——2026-11-21 桌面版崩过一次之后，
 * 就留下一个 307 MB、还占着端口的实验室进程。
 *
 * 判据只有一条：**命令行里带 `--profile rig-<已知 lab id>` 但我们当前没在管理的进程**，
 * 就是孤儿。不按端口杀、不按进程名杀 —— 那些会误伤。
 *
 * Windows 上没有 `/proc`，只能问 WMI。用固定脚本（不经用户输入拼接），失败返回空数组：
 * 回收是「尽力而为」的事，不该因为它失败就影响插件启动。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** 只认这些 profile 前缀：与 naming.js 里的 PROFILE_PREFIX 保持一致。 */
const PROFILE_PATTERN = /--profile\s+(rig-[a-z0-9-]+)/u

/**
 * 列出所有跑着 rig 实验室的进程。
 * @returns {Promise<Array<{pid: number, profile: string, cmd: string}>>}
 */
export async function listLabProcesses() {
  if (process.platform !== 'win32') return []
  const script = [
    '$out = @()',
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object {',
    '  if ($_.CommandLine -match "--profile rig-") { $out += [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine } }',
    '}',
    'Get-CimInstance Win32_Process -Filter "Name=\'DeepSeek Harness.exe\'" | ForEach-Object {',
    '  if ($_.CommandLine -match "--profile rig-") { $out += [pscustomobject]@{ pid = $_.ProcessId; cmd = $_.CommandLine } }',
    '}',
    '$out | ConvertTo-Json -Compress',
  ].join('\n')

  try {
    const { stdout } = await run(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
    )
    const text = stdout.trim()
    if (!text || text === 'null') return []
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .map((row) => {
        const match = PROFILE_PATTERN.exec(String(row.cmd || ''))
        return match ? { pid: Number(row.pid), profile: match[1], cmd: String(row.cmd) } : null
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

/** 杀掉一棵进程树（只用于我们确认过的孤儿 pid）。 */
export async function killOrphan(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`非法 pid：${pid}`)
  try {
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15_000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * 回收：把「跑着 rig 实验室、但不在 tracked 名单里」的进程杀掉。
 *
 * @param {{trackedProfileNames: string[], dryRun?: boolean}} options
 * @returns {Promise<{found: Array<object>, killed: Array<object>, failed: Array<object>}>}
 */
export async function reapOrphans({ trackedProfileNames, dryRun = false }) {
  const tracked = new Set(trackedProfileNames || [])
  const all = await listLabProcesses()
  const orphans = all.filter((item) => !tracked.has(item.profile))
  const killed = []
  const failed = []
  if (dryRun) return { found: orphans, killed, failed }
  for (const orphan of orphans) {
    if (await killOrphan(orphan.pid)) killed.push(orphan)
    else failed.push(orphan)
  }
  return { found: orphans, killed, failed }
}
