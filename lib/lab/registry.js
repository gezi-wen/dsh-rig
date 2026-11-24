/**
 * dsh-rig · 持久状态
 *
 * `labs.json` 里存**静态**字段（名字、版本、路径、profile）与两个例外：
 *   - 端口：固定后要复用，否则每换端口就换 origin，登录态与页面状态全丢（见 port.js）；
 *   - pid / pidStartedAt：**从 2 起落盘**。它不再用于「孤儿探测」那么窄的目的 ——
 *     它是「这条记录现在被谁跑着」的唯一事实来源（见 merge.isForeign）。
 * token 仍然不落盘：落盘等于白送一份凭据到磁盘上，而它每次启动都会重新生成。
 *
 * 这里的函数都是纯的（不碰 fs）：读写由 supervisor 负责，方便单测穷举迁移。
 */
import { STATUS } from './constants.js'
import { profileNameFor } from './naming.js'

/**
 * 当前写法。**加可选字段不动版本号** —— 这与 DSH 官方对会话格式的纪律一致：
 * 只能新增，不能移动或覆盖已存在的内容。
 *
 * 具体教训：0.1.6 一度想升到 2（因为新增了 pid / pidStartedAt），
 * 但 0.1.5 的判定是 `schemaVersion !== 1 → 未知格式 → 按空状态处理`，
 * 于是「回滚到 0.1.5」会把整份 labs.json 读成空的、并在下一次写盘时清掉 ——
 * 为了两个可选字段引入一次数据丢失风险，不划算。
 * 现在 v1 仍是 v1，旧版读到多余字段会忽略它们，只是丢掉 pid 能力。
 */
const SCHEMA_VERSION = 1
/** 能读的版本。将来真需要破坏性变更时，在这里加而不是改 SCHEMA_VERSION。 */
const READABLE_VERSIONS = new Set([1])

/** 空状态。 */
export function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, labs: [] }
}

/** 解析磁盘内容：坏文件不许让插件起不来，一律降级成空状态并说明原因。 */
export function parseState(text) {
  if (typeof text !== 'string' || text.trim() === '') return { state: emptyState(), problem: 'empty' }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { state: emptyState(), problem: 'invalid-json' }
  }
  if (!raw || typeof raw !== 'object' || !READABLE_VERSIONS.has(raw.schemaVersion) || !Array.isArray(raw.labs)) {
    return { state: emptyState(), problem: 'unknown-schema' }
  }
  // 缺字段补默认值（v1 老记录没有 pid / pidStartedAt），不搬内容，所以重复读结果相同。
  const labs = raw.labs
    .filter((lab) => lab && typeof lab.id === 'string')
    .map((lab) => ({
      id: lab.id,
      name: typeof lab.name === 'string' ? lab.name : lab.id,
      version: typeof lab.version === 'string' ? lab.version : 'host',
      profile: typeof lab.profile === 'string' ? lab.profile : profileNameFor(lab.id),
      port: Number.isInteger(lab.port) && lab.port > 0 ? lab.port : null,
      pid: Number.isInteger(lab.pid) && lab.pid > 0 ? lab.pid : null,
      pidStartedAt: typeof lab.pidStartedAt === 'string' ? lab.pidStartedAt : null,
      ownerSessionId: typeof lab.ownerSessionId === 'string' ? lab.ownerSessionId : null,
      ownerSince: typeof lab.ownerSince === 'string' ? lab.ownerSince : null,
      hostId: typeof lab.hostId === 'string' ? lab.hostId : null,
      createdAt: typeof lab.createdAt === 'string' ? lab.createdAt : null,
    }))
  return { state: { schemaVersion: SCHEMA_VERSION, labs }, problem: null }
}

/** 写盘时机用。 */
export function serializeState(state) {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, labs: state.labs }, null, 2)
}

export function findLab(state, id) {
  return state.labs.find((lab) => lab.id === id) || null
}

/** 新增一个实验室（id 已存在则抛，调用方负责先查）。 */
export function addLab(state, lab) {
  if (findLab(state, lab.id)) throw new Error(`实验室 ${lab.id} 已存在`)
  state.labs.push({
    id: lab.id,
    name: lab.name,
    version: lab.version,
    profile: lab.profile,
    port: Number.isInteger(lab.port) && lab.port > 0 ? lab.port : null,
    pid: Number.isInteger(lab.pid) && lab.pid > 0 ? lab.pid : null,
    pidStartedAt: typeof lab.pidStartedAt === 'string' ? lab.pidStartedAt : null,
    ownerSessionId: typeof lab.ownerSessionId === 'string' ? lab.ownerSessionId : null,
    ownerSince: typeof lab.ownerSince === 'string' ? lab.ownerSince : null,
    hostId: typeof lab.hostId === 'string' ? lab.hostId : null,
    createdAt: lab.createdAt || new Date().toISOString(),
  })
  return state
}

export function removeLab(state, id) {
  state.labs = state.labs.filter((lab) => lab.id !== id)
  return state
}

/** 面板视图：静态字段 + 运行时快照（运行时由调用方合并）。 */
export function describeLab(lab, runtime) {
  const live = runtime && typeof runtime === 'object' ? runtime : {}
  return {
    id: lab.id,
    name: lab.name,
    version: lab.version,
    profile: lab.profile,
    createdAt: lab.createdAt,
    status: live.status || STATUS.created,
    port: live.port ?? lab.port ?? null,
    url: live.url || null,
    token: live.token || null,
    pid: live.pid ?? null,
    startedAt: live.startedAt || null,
    exit: live.exit || null,
    ownerSessionId: lab.ownerSessionId || null,
    ownerSince: lab.ownerSince || null,
    hostId: lab.hostId || null,
  }
}
