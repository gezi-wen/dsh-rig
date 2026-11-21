/**
 * dsh-rig · 子进程启动参数
 *
 * 纯函数：给什么算什么，不读环境、不碰磁盘。好处是「不继承凭据」这条能被单测钉死。
 *
 * 两条硬约束：
 *   1. **env 白名单**，不整份继承。任何 `*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD`
 *      一律不进实验室 —— 实验室里的智能体是「可能不稳定」的东西，不该顺手拿到宿主的凭据。
 *      实验室需要的模型凭据走**文件通道**（宿主的 `.credentials.yaml` → 实验室 home），
 *      那是显式的、用户可关的，不是偷偷塞环境变量。
 *   2. **桌面版是 Electron**：`process.execPath` 指向 Electron 本体，必须带
 *      `ELECTRON_RUN_AS_NODE=1` 才会当 node 用（官方 locate-docs 里同一个手法）。
 */

/** 允许继承的环境变量名（大小写不敏感匹配）。 */
const ENV_ALLOW = [
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
  'TZ',
]

/** 出现这些片段的变量一律丢弃（白名单之外再兜一层）。 */
const ENV_DENY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_AUTH)/iu

/**
 * 从宿主 env 里挑出实验室该有的那几项。
 * @param {Record<string, string|undefined>} source
 * @param {Record<string, string>} extra 额外注入（DSH_HOME 等）
 */
export function sanitizeEnv(source, extra = {}) {
  const allow = new Set(ENV_ALLOW)
  const out = {}
  for (const [name, value] of Object.entries(source || {})) {
    if (typeof value !== 'string') continue
    const upper = name.toUpperCase()
    if (ENV_DENY.test(upper)) continue
    if (!allow.has(upper)) continue
    out[name] = value
  }
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === 'string') out[name] = value
  }
  return out
}

/**
 * 组装一次启动计划。
 *
 * @param {object} p
 * @param {string} p.execPath      宿主进程的可执行文件（Electron 或 node）
 * @param {boolean} p.isElectron   process.versions.electron 是否为真
 * @param {string} p.coreBin       DSH 的 lib/bin.js 绝对路径
 * @param {string} p.profile       profile 名（rig-<id>）
 * @param {string} p.cwd           实验室工作区
 * @param {string} p.home          实验室 DSH_HOME
 * @param {Record<string,string|undefined>} p.env 宿主 env
 * @param {string} [p.version]     记入日志用，不进 argv
 */
export function buildStartPlan({ execPath, isElectron, coreBin, profile, cwd, home, env }) {
  if (!execPath) throw new Error('buildStartPlan: 缺少 execPath')
  if (!coreBin) throw new Error('buildStartPlan: 缺少 coreBin')
  if (!profile) throw new Error('buildStartPlan: 缺少 profile')

  // ⚠️ 不能写 `web` 子命令：`dsh web` 本身就是 `--profile web` 的别名，
  // 再叠一个 `--profile rig-xxx` 会被 CLI 判成「select a profile only once」并直接退出
  // （2026-11-21 实测：exit 1，面板显示「已崩溃」）。
  // 自定义 profile 的正确起法是只给 --profile，web 服务由 profile 模板决定。
  const args = [coreBin, '--profile', profile, '--port', '0', '--no-open', '--host', '127.0.0.1']
  const extra = {
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  }
  if (isElectron) extra.ELECTRON_RUN_AS_NODE = '1'

  return {
    command: execPath,
    args,
    cwd,
    env: sanitizeEnv(env, extra),
  }
}

/** 建 profile 的计划（只在第一次创建实验室时跑一次）。 */
export function buildSeedPlan({ execPath, isElectron, coreBin, profile, cwd, home, env, fromProfile = 'web' }) {
  const args = [coreBin, '--profile', profile, '--from-default-profile', fromProfile, '--dump-config']
  const extra = { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  if (isElectron) extra.ELECTRON_RUN_AS_NODE = '1'
  return { command: execPath, args, cwd, env: sanitizeEnv(env, extra) }
}

/** 从实验室 stdout 里抓 URL 与 token。抓不到返回 null，由调用方走兜底。 */
export function parseLabUrl(line) {
  const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/u.exec(String(line || ''))
  if (!m) return null
  return { port: Number(m[1]), token: m[2], url: m[0] }
}
