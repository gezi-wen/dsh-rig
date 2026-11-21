/**
 * dsh-rig · 常量与状态词表
 *
 * 纪律：**一个数字只许在这里定义一次**。别处（supervisor / 路由 / 面板）需要时 import，
 * 不许就地写死 —— 写死的副本没有测试扫得到，迟早和这里漂移。
 */

/** 面板/路由共用的 API 前缀。client 半的 fetch 与 host 半的路由必须用同一个常量。 */
export const API_PREFIX = '/dsh-rig/api'

/** 默认值。宿主插件 Config 未提供时全部落在这里。 */
export const DEFAULTS = {
  /** 实验室根目录**名字**（真正路径由运行时拼：%LOCALAPPDATA%\<名字>）。 */
  rootName: 'dsh-rig',
  /** 启动超时：等 HTTP 200 的最长时间。 */
  startTimeoutMs: 60_000,
  /** 健康探测间隔。 */
  healthPollMs: 500,
  /** 每个实验室保留的日志行数（环形缓冲）。 */
  logRingLines: 2_000,
  /** 同时存在的实验室上限（每个都是一个 node 进程 + 一份 DSH_HOME）。 */
  maxLabs: 8,
  /** 远端版本清单缓存时长。 */
  versionsCacheMs: 60 * 60 * 1_000,
  /** 复制宿主凭据到实验室（实验室里的智能体才有模型可用）。 */
  copyCredentials: true,
}

/**
 * 状态机。`starting` 与 `running` 是「活着」，其余是「没在跑」。
 * 迁移合法性只在这里判定，别处不许自己 switch。
 */
export const STATUS = {
  created: 'created',
  starting: 'starting',
  running: 'running',
  stopped: 'stopped',
  crashed: 'crashed',
}

/** 允许的状态迁移。刻意不做「任意跳」——崩溃与正常停止必须能分开。 */
const TRANSITIONS = {
  created: ['starting', 'stopped'],
  starting: ['running', 'crashed', 'stopped'],
  running: ['stopped', 'crashed'],
  stopped: ['starting', 'created'],
  crashed: ['starting', 'created', 'stopped'],
}

/** @returns {boolean} */
export function canTransition(from, to) {
  const list = TRANSITIONS[from]
  return Array.isArray(list) && list.includes(to)
}

/** 是否正在跑（这两态才允许 kill / 探健康）。 */
export function isLive(status) {
  return status === STATUS.starting || status === STATUS.running
}

/** 给日志与面板用的中文标签（locale 化留到 M3）。 */
export const STATUS_LABEL = {
  created: '未启动',
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  crashed: '已崩溃',
}
