/**
 * dsh-rig · 命名与隔离判定（纯逻辑层）
 *
 * 纪律：**零 `node:` 内建、零 IO**。这一层要能被穷举断言，所以路径比较自己写字符串逻辑，
 * 不借 `node:path`（借了就得在测试里模拟平台分隔符，反而更脆）。
 *
 * 唯一真相源：profile 前缀 `rig-` 只在这里出现；id 白名单只在这里判。
 */

/** 实验室 profile 的固定前缀。内置模板叫 web/desktop/headless，绝不能撞。 */
export const PROFILE_PREFIX = 'rig-'

/** id 白名单：小写字母数字与短横，1–24 字符，不能以短横开头。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/u

export function isValidLabId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id)
}

export function profileNameFor(id) {
  return `${PROFILE_PREFIX}${id}`
}

/** 从 1 开始找一个没用过的 id（传已有 id 列表，纯函数）。 */
export function nextLabId(existing) {
  const used = new Set(Array.isArray(existing) ? existing : [])
  for (let i = 1; i <= 999; i += 1) {
    const id = `lab${i}`
    if (!used.has(id)) return id
  }
  return null
}

/**
 * 路径归一：统一分隔符、去尾分隔符、Windows 下转小写。
 * 只做比较用的归一，**不是**真实路径解析（不处理 `..`、不解析符号链接）——
 * 真正的等价判定由调用方补 realpath，这里管的是「同一处」的粗判。
 */
export function normalizeForCompare(p) {
  if (typeof p !== 'string' || p === '') return ''
  let s = p.replace(/[\\/]+/gu, '/').replace(/\/+$/u, '')
  // 盘符大小写与整体大小写：Windows 文件系统不区分
  if (/^[a-z]:/iu.test(s)) s = s.toLowerCase()
  return s
}

/**
 * 隔离判定：实验室 home 与宿主 home 必须互不包含。
 *
 * 三个方向都要挡：相等、实验室在宿主里面、宿主在实验室里面。
 * 这是整个项目唯一一条硬约束的**唯一**判据实现 —— 别处不许再写一份。
 *
 * @returns {{ok: boolean, reason?: string}}
 */
export function assertIsolated(labHome, hostHome) {
  const a = normalizeForCompare(labHome)
  const b = normalizeForCompare(hostHome)
  if (a === '' || b === '') return { ok: false, reason: '路径为空，无法判定隔离' }
  if (a === b) return { ok: false, reason: '实验室 DSH_HOME 与宿主相同' }
  if (a.startsWith(`${b}/`)) return { ok: false, reason: '实验室 DSH_HOME 落在宿主 DSH_HOME 里面' }
  if (b.startsWith(`${a}/`)) return { ok: false, reason: '宿主 DSH_HOME 落在实验室 DSH_HOME 里面' }
  return { ok: true }
}

/**
 * 从**安装路径**里读 profile 名：<home>/profiles/<name>/node_modules/<pkg>/lib/index.js。
 *
 * 为什么不信 DSH_PROFILE/DSH_PROFILE_DIR：从别的会话派生的进程会把这两个变量一起继承下去。
 * 2026-11-21 实测：起着 --profile web 的实例，插件却报 desktop，因为父进程的环境被带进来了。
 * 自己的安装位置不会说谎 —— 它就在那个 profile 的 node_modules 里。
 */
export function profileFromInstallPath(anyPath) {
  // 先把连续分隔符折成一个：URL 形式是 /，Windows 字面量可能是 \\，直接匹配会漏。
  const normalized = String(anyPath || '').replace(/[\\/]+/gu, '/')
  const m = /\/profiles\/([^/]+)\//u.exec(normalized)
  return m ? m[1] : null
}