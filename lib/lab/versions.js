/**
 * dsh-rig · DSH 版本来源
 *
 * 三档来源，代价从低到高：
 *   1. `host` —— 直接用宿主那份 core（离线、秒开，默认）；
 *   2. 已缓存版本 —— `<labRoot>/core/<ver>/` 里装好的；
 *   3. 装新版本 —— npm 拉一个 @deepseek-ai/dsh@<ver> 进去（要联网，每版几百 MB）。
 *
 * M1 只做「解析宿主 core + 列已缓存 + 列远端」，安装动作留到 M2（要带进度与磁盘占用确认）。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const run = promisify(execFile)

/** 宿主 core 的候选位置：环境变量优先，其次从安装根推。 */
export function hostCoreCandidates(env) {
  const out = []
  if (env.DSH_INSTALL_DIR) out.push(join(env.DSH_INSTALL_DIR, 'lib', 'bin.js'))
  // 桌面版：resources/app/dsh/lib/bin.js
  if (env.DSH_RESOURCES_PATH) out.push(join(env.DSH_RESOURCES_PATH, 'app', 'dsh', 'lib', 'bin.js'))
  return out
}

/**
 * 解析宿主 core 的 bin.js。
 * 顺序：显式候选 → 从当前模块位置向上找 `node_modules/@deepseek-ai/dsh/lib/bin.js`。
 * 找不到返回 `{ bin: null, source }`，由调用方决定怎么报错（不抛）。
 */
export function resolveHostCore(env, fromFileUrl) {
  for (const bin of hostCoreCandidates(env)) {
    if (bin) return { bin, source: 'env' }
  }
  try {
    const require = createRequire(fromFileUrl || import.meta.url)
    const pkg = require.resolve('@deepseek-ai/dsh/package.json')
    return { bin: join(pkg, '..', 'lib', 'bin.js'), source: 'resolve' }
  } catch {
    return { bin: null, source: 'missing' }
  }
}

/** 列 `<labRoot>/core/*` 里已装好的版本。坏目录（没 lib/bin.js）跳过。 */
export async function listCachedVersions(coreDir) {
  let names = []
  try {
    names = await readdir(coreDir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const bin = join(coreDir, name, 'lib', 'bin.js')
    try {
      const st = await stat(bin)
      if (st.isFile()) out.push({ version: name, bin })
    } catch {
      /* 半个 core：M2 会清理 .partial，这里先跳过 */
    }
  }
  return out.sort((a, b) => a.version.localeCompare(b.version))
}

/** 远端版本清单：`npm view` 一次，带超时与缓存。失败**不抛**，返回错误描述。 */
export async function listRemoteVersions({ execPath, isElectron, env, cacheMs = 3_600_000, now = Date.now() }) {
  const state = remoteCache
  if (state.value && now - state.at < cacheMs) return { ...state.value, cached: true }

  const npmEnv = { ...env }
  if (isElectron) npmEnv.ELECTRON_RUN_AS_NODE = '1'
  try {
    // npm 在 Windows 上是 .cmd，必须 shell 才能起来；参数是常量，无注入面。
    const { stdout } = await run(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['view', '@deepseek-ai/dsh', 'versions', '--json'],
      { timeout: 20_000, env: npmEnv, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    )
    const versions = JSON.parse(stdout)
    const value = {
      versions: Array.isArray(versions) ? versions.filter((v) => typeof v === 'string') : [],
      fetchedAt: new Date(now).toISOString(),
      error: null,
    }
    remoteCache = { at: now, value }
    return { ...value, cached: false }
  } catch (err) {
    const value = {
      versions: [],
      fetchedAt: new Date(now).toISOString(),
      error: String(err?.message ?? err).slice(0, 300),
    }
    // 失败也缓存一小会儿，避免面板每次刷新都去撞一次网络。
    remoteCache = { at: now, value }
    return { ...value, cached: false }
  }
}

let remoteCache = { at: 0, value: null }

/** 测试用：清掉远端缓存。 */
export function resetRemoteCache() {
  remoteCache = { at: 0, value: null }
}
