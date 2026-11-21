/**
 * dsh-rig · 界面手柄的会话表（IO 层）
 *
 * 一个实验室对应**一个**浏览器会话：首屏只加载一次，后续动作复用同一页。
 * 为什么不让每个动作各起一个浏览器：冷启动 1–3 秒、还带一份 user-data-dir，
 * 智能体连点三下就等九秒，体验比点不动还差。
 *
 * 两条失效规则：
 *   - 实验室重启后端口与 token 都变 → 旧会话指向死地址，URL 变了就重建；
 *   - 没有可用后端时**不缓存失败**：用户可以中途装上 playwright，下次调用要能好。
 */
import { join } from 'node:path'
import { createDriver, probeDriver } from './driver.js'

export class UiSessions {
  #map = new Map()
  #log
  #preference

  constructor({ log, preference = 'auto' }) {
    this.#log = typeof log === 'function' ? log : () => {}
    this.#preference = preference
  }

  /** 有没有可用后端（probeDriver 只探测，不启动浏览器）。 */
  available() {
    return probeDriver({ preference: this.#preference })
  }

  async #driverFor(id, url, labDir) {
    const existing = this.#map.get(id)
    if (existing && existing.url === url) return existing.driver
    if (existing) {
      void existing.driver.close()
      this.#map.delete(id)
    }
    const { driver, backend, reason } = await createDriver({
      labUrl: url,
      userDataDir: join(labDir, 'browser-profile'),
      shotsDir: join(labDir, 'shots'),
      log: (line) => this.#log(`[ui:${id}] ${line}`),
      preference: this.#preference,
    })
    if (!driver) {
      throw new Error(
        `界面驱动不可用：${reason || '没有可用后端'}。装 playwright 或指定 DSH_RIG_BROWSER 后重试`,
      )
    }
    this.#log(`[ui:${id}] 后端=${backend}`)
    this.#map.set(id, { url, driver })
    return driver
  }

  async call(id, url, labDir, action, args = {}) {
    const driver = await this.#driverFor(id, url, labDir)
    switch (action) {
      case 'snapshot':
        return driver.snapshot(args.limit)
      case 'screenshot':
        return driver.screenshot()
      case 'click': {
        if (!args.text) throw new Error('click 需要 text（按钮上的文字）')
        return driver.click(args.text)
      }
      case 'type': {
        if (!args.text) throw new Error('type 需要 text')
        return driver.type(args.text, { submit: Boolean(args.submit) })
      }
      case 'task': {
        if (!args.text) throw new Error('task 需要 text')
        return driver.type(args.text, { submit: true })
      }
      case 'open': {
        if (!args.path) throw new Error('open 需要 path')
        const target = new URL(args.path, url).toString()
        await driver.evaluate(`(() => { location.href = ${JSON.stringify(target)}; return true })()`)
        return { navigated: target }
      }
      case 'eval': {
        if (!args.expression) throw new Error('eval 需要 expression')
        return { value: await driver.evaluate(String(args.expression), { awaitPromise: true }) }
      }
      default:
        throw new Error(`未知界面动作 ${action}（可用：snapshot / screenshot / click / type / task / open / eval）`)
    }
  }

  close(id) {
    const entry = this.#map.get(id)
    if (!entry) return
    this.#map.delete(id)
    void entry.driver.close()
  }

  async closeAll() {
    const entries = [...this.#map.values()]
    this.#map.clear()
    await Promise.all(entries.map((entry) => entry.driver.close()))
  }
}
