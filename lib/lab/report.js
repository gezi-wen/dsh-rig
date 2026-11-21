/**
 * dsh-rig · 实验室体检（IO 层，只读）
 *
 * 为什么先做它：实验室要面对各种稀奇古怪的插件，最值钱的不是「点它」，是「看清它」。
 * 而「看清它」大部分**不需要**实验室配合 —— profile 声明、工作区文件、启动日志里的
 * 加载失败，全在磁盘上；进程/端口状态在宿主自己手里。
 *
 * 报告分四块，各自有明确的证据来源，读不到就说读不到：
 *   1. declared  —— profile 声明了哪些 bundle / 依赖（`profiles/<名>/package.json`）
 *   2. patched   —— 组合补丁里的行（`profiles/<名>/cordis.patch.yml`）
 *   3. runtime   —— 状态 / pid / 端口 / 退出码（宿主运行时表）
 *   4. logFacts  —— 启动期被禁用或加载失败的插件行（从宿主捕获的 stderr 里解析）
 * 外加 workspace 顶层文件树。
 *
 * 一条纪律：**这里给出的每条都是「我看到了什么」，不是「应该是什么」**。
 * 读失败就写 `null` 与原因，绝不编一个空数组冒充「没有」。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEPTH_LIMIT = 2
const ENTRY_LIMIT = 80

/** 读 JSON；失败返回 `{value:null, error}`，不抛。 */
async function readJsonSafe(file) {
  try {
    return { value: JSON.parse(await readFile(file, 'utf8')), error: null }
  } catch (err) {
    return { value: null, error: String(err?.code || err?.message || err) }
  }
}

async function readTextSafe(file) {
  try {
    return { value: await readFile(file, 'utf8'), error: null }
  } catch (err) {
    return { value: null, error: String(err?.code || err?.message || err) }
  }
}

/** 工作区顶层（最多两层）文件树，只报名字与类型。 */
async function listWorkspace(dir, depth = 0, prefix = '') {
  if (depth > DEPTH_LIMIT) return []
  let names = []
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name)).slice(0, ENTRY_LIMIT)) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'browser-profile') continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    out.push({ path: rel, dir: entry.isDirectory() })
    if (entry.isDirectory()) out.push(...(await listWorkspace(join(dir, entry.name), depth + 1, rel)))
    if (out.length > ENTRY_LIMIT) break
  }
  return out.slice(0, ENTRY_LIMIT)
}

/** 从 `cordis.patch.yml` 里抠出 `- id / name` 对（组合补丁是声明式文本，不需要全量 YAML 解析）。 */
export function parsePatchRows(text) {
  if (typeof text !== 'string') return []
  const rows = []
  let current = null
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/#.*$/u, '')
    const idMatch = /^\s*-\s*id:\s*(.+)$/u.exec(line)
    if (idMatch) {
      if (current) rows.push(current)
      current = { id: idMatch[1].trim().replace(/^['"]|['"]$/gu, ''), name: null }
      continue
    }
    const nameMatch = /^\s*name:\s*(.+)$/u.exec(line)
    if (nameMatch && current && !current.name) current.name = nameMatch[1].trim().replace(/^['"]|['"]$/gu, '')
  }
  if (current) rows.push(current)
  return rows
}

/** 从宿主捕获的启动日志里解析「被禁用 / 加载失败」的插件行。 */
export function parseLogFacts(entries) {
  const denied = new Map()
  const failures = []
  for (const entry of entries || []) {
    const text = String(entry.text || '')
    const denying = /disabling profile plugin row "([^"]+)":\s*(.*)$/u.exec(text)
    if (denying) {
      // 同 id 只留**第一条**：后出现的往往是「已禁用」的重复提示，信息量更少。
      if (!denied.has(denying[1])) denied.set(denying[1], denying[2].slice(0, 240))
      continue
    }
    if (/^(Error|error):|Cannot find package|ERR_MODULE_NOT_FOUND|failed to load/u.test(text)) {
      failures.push(text.slice(0, 240))
    }
  }
  return { denied: [...denied.entries()].map(([id, reason]) => ({ id, reason })), failures: failures.slice(0, 12) }
}

/**
 * 组装一份报告。所有输入都从外面传进来，方便测试与替换。
 *
 * @returns {Promise<object>}
 */
export async function buildLabReport({ lab, runtime, labPaths, logEntries }) {
  const profileDir = join(labPaths.home, 'profiles', lab.profile)
  const pkg = await readJsonSafe(join(profileDir, 'package.json'))
  const patch = await readTextSafe(join(profileDir, 'cordis.patch.yml'))
  const declared = pkg.value
    ? {
        bundles: Array.isArray(pkg.value.dsh?.profile?.bundles) ? pkg.value.dsh.profile.bundles : [],
        dependencies: Object.keys(pkg.value.dependencies || {}),
        error: null,
      }
    : { bundles: [], dependencies: [], error: pkg.error }

  return {
    lab: { id: lab.id, name: lab.name, version: lab.version, profile: lab.profile },
    runtime: {
      status: runtime?.status ?? 'unknown',
      pid: runtime?.pid ?? null,
      port: runtime?.port ?? null,
      startedAt: runtime?.startedAt ?? null,
      exit: runtime?.exit ?? null,
    },
    declared,
    patched: {
      rows: patch.value ? parsePatchRows(patch.value) : [],
      error: patch.error,
    },
    logFacts: parseLogFacts(logEntries),
    workspace: await listWorkspace(labPaths.workspace),
  }
}

/** 把报告压成一段给人/模型读的文本（工具回执用）。 */
export function renderReport(report) {
  const lines = []
  const { lab, runtime, declared, patched, logFacts, workspace } = report
  lines.push(`实验室 ${lab.id}（${lab.name}） · ${runtime.status} · profile=${lab.profile}`)
  lines.push(
    `  进程：${runtime.pid ?? '—'} 端口 ${runtime.port ?? '—'} 退出 ${runtime.exit ? `code=${runtime.exit.code ?? 'null'}` : '—'}`,
  )
  lines.push(`  声明：${declared.bundles.length} 个 bundle${declared.error ? `（读不到：${declared.error}）` : ''}`)
  if (declared.bundles.length) lines.push(`    ${declared.bundles.join(', ')}`)
  lines.push(`  补丁行：${patched.rows.length} 条${patched.error ? `（读不到：${patched.error}）` : ''}`)
  if (patched.rows.length) {
    lines.push(`    ${patched.rows.slice(0, 12).map((r) => r.id).join(', ')}${patched.rows.length > 12 ? ' …' : ''}`)
  }
  if (logFacts.denied.length) {
    lines.push(`  启动期被禁用：${logFacts.denied.length} 行（这些在实验室里是**没有生效**的）`)
    for (const item of logFacts.denied.slice(0, 8)) lines.push(`    ${item.id} — ${item.reason}`)
  }
  if (logFacts.failures.length) {
    lines.push(`  启动期错误：${logFacts.failures.length} 条`)
    for (const line of logFacts.failures.slice(0, 5)) lines.push(`    ${line}`)
  }
  lines.push(`  工作区：${workspace.length} 项`)
  for (const item of workspace.slice(0, 16)) lines.push(`    ${item.dir ? '▸' : '·'} ${item.path}`)
  if (workspace.length > 16) lines.push(`    …另有 ${workspace.length - 16} 项`)
  return lines.join('\n')
}
