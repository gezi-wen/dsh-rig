/**
 * dsh-rig · `labs.json` 的读写（IO 层 · 唯一写这个是它）
 *
 * 以前这一步写在 supervisor 里：读一次、写一次，各自为政。桌面版和 web 版同时装着插件时，
 * 两个进程共用同一份文件，谁后写谁赢 —— 另一端刚建的实验室记录会被这一端的旧内存状态抹掉。
 *
 * 现在的做法是「**锁 → 读盘 → 合并 → 写**」：
 *   - 锁用 `labs.json.lock`（`wx` 打开，独占）；持有者崩了留下的死锁按 mtime 判陈旧后打破；
 *   - 合并规则在 `merge.js`（纯逻辑，可单测）；
 *   - 写仍然是「临时文件 + rename」，保证读到的是完整 JSON，不会读到半截。
 *
 * 分工：这个模块只认文件与锁，不认识实验室；状态怎么解释归 `registry.js`。
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { emptyState, parseState, serializeState } from './registry.js'
import { mergeStates } from './merge.js'

const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 4_000
/** 锁文件比这还旧 = 持锁的进程已经没了（正常持锁只有毫秒级）。 */
const LOCK_STALE_MS = 10_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class LabStateStore {
  #file
  #log

  /**
   * @param {{file: string, log?: (line: string) => void}} options `file` 是 `labs.json` 的绝对路径
   */
  constructor(options) {
    this.#file = options.file
    this.#log = typeof options.log === 'function' ? options.log : () => {}
  }

  get file() {
    return this.#file
  }

  /**
   * 读盘。读不到 / 坏了都降级成空状态并说明原因（绝不让插件起不来）。
   * @returns {Promise<{state: object, problem: string|null}>}
   */
  async load() {
    try {
      const text = await readFile(this.#file, 'utf8')
      return parseState(text)
    } catch (err) {
      if (err && err.code === 'ENOENT') return { state: emptyState(), problem: null }
      return { state: emptyState(), problem: String((err && err.message) || err) }
    }
  }

  /**
   * 合并落盘：拿锁 → 读盘 → 与 `ours` 合并 → 写。
   * @param {object} ours 本进程的状态（以它为准的那部分）
   * @returns {Promise<object>} 合并后的状态（调用方应当拿它替换内存状态）
   */
  async save(ours) {
    await mkdir(this.#dirOr('.', this.#file), { recursive: true })
    return this.#withLock(async () => {
      const { state: disk } = await this.load()
      const merged = mergeStates(disk, ours)
      await this.#write(merged)
      return merged
    })
  }

  /**
   * 单独读一次并与内存合并（`create` 之前刷新 id 用）。
   * @param {object} ours 本进程状态
   * @returns {Promise<object>} 合并结果（不写盘）
   */
  async refresh(ours) {
    const { state: disk } = await this.load()
    return mergeStates(disk, ours)
  }

  #dirOr(fallback, file) {
    const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
    return cut > 0 ? file.slice(0, cut) : fallback
  }

  async #write(state) {
    const tmp = `${this.#file}.tmp`
    await writeFile(tmp, serializeState(state), 'utf8')
    await rename(tmp, this.#file)
  }

  async #withLock(fn) {
    const lockPath = `${this.#file}.lock`
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx')
        try {
          await handle.writeFile(`${process.pid} ${new Date().toISOString()}`, 'utf8')
        } finally {
          await handle.close()
        }
        break
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err
        const stale = await this.#isStale(lockPath)
        if (stale) {
          this.#log(`[dsh-rig] 发现陈旧的 labs.json 锁（${lockPath}），清掉重试`)
          await rm(lockPath, { force: true })
          continue
        }
        if (Date.now() > deadline) {
          throw new Error('labs.json 被另一个宿主进程锁着，等超时了 —— 稍后重试')
        }
        await sleep(LOCK_RETRY_MS)
      }
    }
    try {
      return await fn()
    } finally {
      await rm(lockPath, { force: true })
    }
  }

  async #isStale(lockPath) {
    try {
      const info = await stat(lockPath)
      return Date.now() - info.mtimeMs > LOCK_STALE_MS
    } catch {
      // 锁刚好被别人放掉了：当作不陈旧，下一轮会自己拿到
      return false
    }
  }
}
