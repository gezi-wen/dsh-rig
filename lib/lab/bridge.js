/**
 * dsh-rig · 内桥（IO 层）
 *
 * 两件事：
 *   1. `ensureBridge()`：把桥插件装进实验室 profile，并把 `cordis.patch.yml` 的 insert 行补上。
 *      ⚠️ 装 ≠ 加载：只 `plugin add` 只会进 dependencies，DSH 会警告
 *      「installed as a plain dependency, not a profile layer」并且根本不加载（路由 404）。
 *   2. `sendToLab()`：调用实验室里的 `/bridge/send`，把一句话投进它的会话。
 *
 * 为什么走桥而不是模拟界面：`lab_ui` 是「像人一样点」，桥是「进程内 followup」——
 * 前者适合验证 UI，后者才是派活。两条都留着，各管一段。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPluginPlan } from './spawn-plan.js'
import { resolveCoreBin } from './core-bin.js'
import { runOnce } from './seed.js'
import { installPlugin } from './install.js'
import { ensureProfile } from './provision.js'

/** 本包根目录（用来指给实验室装桥插件时用）。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BRIDGE_SPEC = `file:${PACKAGE_ROOT.replace(/\\/gu, '/')}/lib/bridge/plugin`
const BRIDGE_NAME = 'dsh-rig-bridge'
const INSERT_BLOCK = `- insert:\n    - id: ${BRIDGE_NAME}\n      name: ${BRIDGE_NAME}\n`

/** patch 里已经有桥的 insert 行了吗。 */
function hasBridgeLine(text) {
  return typeof text === 'string' && text.includes(BRIDGE_NAME)
}

/**
 * 确保实验室 profile 里既装了桥、又在 patch 层里 insert 了。
 * @returns {Promise<{ok: boolean, installed: boolean, patched: boolean, reason: string|null}>}
 */
export async function ensureBridge(options) {
  const { root, lab, home, workspace, execPath, isElectron, version, env, log } = options
  // profile 必须先在：不存在时 pnpm 那条会 exit null，什么线索都不给。
  const provision = await ensureProfile({ lab, home, workspace, execPath, isElectron, version, root, env, log })
  if (!provision.ok) return { ok: false, installed: false, patched: false, reason: 'profile-missing' }

  const profileDir = join(home, 'profiles', lab.profile)
  let installed = false
  try {
    const pkg = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
    installed = Boolean(pkg?.dependencies?.[BRIDGE_NAME])
  } catch {
    installed = false
  }
  if (!installed) {
    const result = await installPlugin({ lab, spec: BRIDGE_SPEC, home, workspace, execPath, isElectron, version, root, env, log })
    if (!result.ok) return { ok: false, installed: false, patched: false, reason: result.reason }
  }

  const patchFile = join(profileDir, 'cordis.patch.yml')
  let patched = false
  try {
    const text = await readFile(patchFile, 'utf8')
    if (!hasBridgeLine(text)) {
      // 空装载层（通常就是 "[]"）直接换成 insert 块；否则追加一段。
      const next = /^\s*\[\]\s*$/mu.test(text) ? text.replace(/\[\]/u, INSERT_BLOCK.trimEnd()) : `${text.trimEnd()}\n${INSERT_BLOCK}`
      await writeFile(patchFile, next, 'utf8')
      patched = true
    }
  } catch {
    await writeFile(patchFile, INSERT_BLOCK, 'utf8')
    patched = true
  }
  if (patched) log('rig', '已把桥写进实验室的 patch 层（重启实验室后加载）')
  return { ok: true, installed: !installed || installed, patched, reason: null }
}

/**
 * 往实验室的会话投一条用户消息。
 * @param {{labUrl: string|null, text: string, sessionId?: string}} p
 */
export async function sendToLab({ labUrl, text, sessionId = 'rig-bridge', wait = true, timeoutMs = 180_000 }) {
  if (!labUrl) return { ok: false, reason: '实验室没在运行（没有 url）' }
  const url = new URL('/bridge/send', labUrl)
  const body = JSON.stringify({ text, sessionId, wait, timeoutMs })
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs + 60_000) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, reason: data.error || `HTTP ${res.status}` }
    return { ok: true, ...data }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) }
  }
}

/** 给测试与诊断用：桥插件在本包里的位置。 */
export const BRIDGE_PLUGIN_SPEC = BRIDGE_SPEC
export { BRIDGE_NAME }

/**
 * 拉实验室会话的最近事件（只回「发生了什么」，不回全文）。
 * @returns {Promise<{ok: boolean, sessionId?: string, total?: number, events?: Array<object>, reason?: string}>}
 */
export async function fetchEvents({ labUrl, sessionId = 'rig-bridge', limit = 20 }) {
  if (!labUrl) return { ok: false, reason: '实验室没在运行（没有 url）' }
  try {
    const url = new URL('/bridge/events', labUrl)
    url.searchParams.set('sessionId', sessionId)
    url.searchParams.set('limit', String(limit))
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, reason: data.error || `HTTP ${res.status}` }
    return { ok: true, ...data }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err) }
  }
}
