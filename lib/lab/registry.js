/**
 * dsh-rig · 持久状态
 *
 * `labs.json` 里只存**静态**字段（名字、版本、路径、profile）。端口、token、pid 一律不落盘：
 *   - 端口每次启动都会变（`--port 0` 由系统分配）；
 *   - token 是每次启动现生成的，落盘等于白送一份凭据到磁盘上；
 *   - pid 落盘的价值只有「孤儿探测」，用 `startedAt` 一起存才判得准，M2 再补。
 *
 * 这里的函数都是纯的（不碰 fs）：读写由 supervisor 负责，方便单测穷举迁移。
 */
import { STATUS } from './constants.js'
import { profileNameFor } from './naming.js'

const SCHEMA_VERSION = 1

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
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.labs)) {
    return { state: emptyState(), problem: 'unknown-schema' }
  }
  const labs = raw.labs
    .filter((lab) => lab && typeof lab.id === 'string')
    .map((lab) => ({
      id: lab.id,
      name: typeof lab.name === 'string' ? lab.name : lab.id,
      version: typeof lab.version === 'string' ? lab.version : 'host',
      profile: typeof lab.profile === 'string' ? lab.profile : profileNameFor(lab.id),
      port: Number.isInteger(lab.port) && lab.port > 0 ? lab.port : null,
      ownerSessionId: typeof lab.ownerSessionId === 'string' ? lab.ownerSessionId : null,
      ownerSince: typeof lab.ownerSince === 'string' ? lab.ownerSince : null,
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
    ownerSessionId: typeof lab.ownerSessionId === 'string' ? lab.ownerSessionId : null,
    ownerSince: typeof lab.ownerSince === 'string' ? lab.ownerSince : null,
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
  }
}
